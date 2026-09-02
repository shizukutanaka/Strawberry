// tests/orders/no-credentials-after-termination.test.js
//
// access-delivery.js はこう主張している:
//   「復号して返すのは『その注文の借り手』だけ、『支払い済み』かつ『稼働中』の間だけ。
//     終了時に破棄し、その全過程を監査ログに残す」
//
// 問: **終了時に破棄しているのは誰か。**
// 答（修正前）: 終端へ遷移させる 8 経路のうち 3 本だけ。SLA 違反による自動終了・
// 係争の返金裁定・係争の棄却・期限切れ active 注文の失効・係争の自動裁定の 5 本は、
// レンタルが終わったあとも暗号化された SSH 鍵を data/orders.json に残していた。
//
// 修正は 5 箇所への追記ではない（6 本目でまた忘れる）。OrderRepository の書き込み経路で
// 「終端状態の注文は accessDelivery を持てない」を強制した。このテストはその保証が
// **経路の数え上げに依存せずに**成り立つことを示す:
//   1. 注文を書く経路は OrderRepository しかない（＝ beforeWrite を必ず通る）
//   2. その beforeWrite が終端状態で確実に落とす
//   3. 実際に漏れていた 5 経路が、いま塞がっている（回帰）
//   4. 修正前に終端へ落ちた注文は掃き出しジョブが後から拾う
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const accessDelivery = require('../../src/marketplace/access-delivery');
const orderExpiry = require('../../src/utils/order-expiry');
const orderRoutes = require('../../src/api/routes/order/index');

const SRC = path.resolve(__dirname, '../../src');
const uniq = `nct${Date.now().toString(36)}`;

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise((done) => (server && server.close ? server.close(() => done()) : done()));
});

function jsFilesUnder(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) jsFilesUnder(full, out);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SEALED = () => accessDelivery.seal({
  method: 'ssh', endpoint: 'gpu.example.com:22', username: 'renter',
  credential: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
});

async function makeUser(prefix, role) {
  const name = `${prefix}${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const u = UserRepository.getByEmail(email);
  if (role) UserRepository.update(u.id, { role });
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: u.id, token };
}

// ─── 1. 前提: 注文を書く経路は OrderRepository しかない ──────────────────────
describe('the repository is the only writer of orders.json', () => {
  it('no module outside src/db/json writes the order file directly', () => {
    // これが崩れると beforeWrite を迂回できてしまい、以下の保証がすべて無効になる。
    // 「orders.json」という語がコメントに出るのは構わない。書き込みの実体
    // （atomicWriteJSON / writeFileSync）を持つ file を探す。
    const offenders = jsFilesUnder(SRC)
      .filter((f) => !f.includes(`${path.sep}db${path.sep}json${path.sep}`))
      .filter((f) => {
        const src = fs.readFileSync(f, 'utf-8');
        return /orders\.json/.test(src) && /atomicWriteJSON\s*\(|writeFileSync\s*\(/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('no route or job hand-writes the purge any more (one mechanism, not nine)', () => {
    // 各所で `accessDelivery: null` を書いて回る形に戻ると、「書いた場所は守られている」
    // という誤った安心が生まれ、書き忘れた経路が再び見えなくなる。
    const offenders = jsFilesUnder(SRC)
      .filter((f) => !f.endsWith(path.join('db', 'json', 'OrderRepository.js')))
      .filter((f) => /accessDelivery\s*[:=]\s*null/.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});

// ─── 2. 不変条件そのもの ────────────────────────────────────────────────────
describe('OrderRepository drops the access credential on any write that lands in a terminal state', () => {
  it.each(['completed', 'cancelled'])('update() to %s', (status) => {
    const order = OrderRepository.create({ userId: 'u', status: 'active', accessDelivery: SEALED() });
    expect(order.accessDelivery).toBeTruthy();
    const updated = OrderRepository.update(order.id, { status });
    expect(updated.accessDelivery).toBeNull();
    expect(OrderRepository.getById(order.id).accessDelivery).toBeNull();
  });

  it.each(['completed', 'cancelled'])('updateIf() to %s', (status) => {
    const order = OrderRepository.create({ userId: 'u', status: 'active', accessDelivery: SEALED() });
    const result = OrderRepository.updateIf(order.id, (o) => o.status === 'active', { status });
    expect(result.ok).toBe(true);
    expect(result.row.accessDelivery).toBeNull();
  });

  it('create() cannot start life as a terminal order holding a credential', () => {
    const order = OrderRepository.create({ userId: 'u', status: 'completed', accessDelivery: SEALED() });
    expect(order.accessDelivery).toBeNull();
  });

  it('keeps the credential while the rental is still running (the invariant is not a blanket delete)', () => {
    const order = OrderRepository.create({ userId: 'u', status: 'active', accessDelivery: SEALED() });
    const updated = OrderRepository.update(order.id, { status: 'preempting' });
    expect(updated.accessDelivery).toBeTruthy();
    expect(accessDelivery.open(updated.accessDelivery).credential).toContain('BEGIN OPENSSH');
  });
});

// ─── 3. 実際に漏れていた 5 経路の回帰 ───────────────────────────────────────
describe('the five paths that used to leave the credential behind', () => {
  let renter, provider, admin, gpuId;

  beforeAll(async () => {
    renter = await makeUser('nctrent');
    provider = await makeUser('nctprov', 'provider');
    admin = await makeUser('nctadm', 'admin');
    gpuId = GpuRepository.create({
      name: 'Purge GPU', vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 100, providerId: provider.id,
    }).id;
  });

  function activeOrderWithAccess(extra = {}) {
    const order = OrderRepository.create({
      userId: renter.id, providerId: provider.id, gpuId, durationMinutes: 60, totalPrice: 100,
      status: 'active', startedAt: new Date().toISOString(), accessDelivery: SEALED(), ...extra,
    });
    PaymentRepository.create({
      orderId: order.id, userId: renter.id, status: 'paid', amount: 100, method: 'lightning',
      paidAt: new Date().toISOString(),
    });
    expect(OrderRepository.getById(order.id).accessDelivery).toBeTruthy();
    return order;
  }

  const assertPurged = (orderId) => {
    const after = OrderRepository.getById(orderId);
    expect(after.status === 'completed' || after.status === 'cancelled').toBe(true);
    expect(after.accessDelivery).toBeNull();
  };

  it('SLA breach auto-termination (heartbeat gone) leaves no credential', () => {
    const order = activeOrderWithAccess();
    // ハートビートが一度も無いセッションは対象外なので、1 本だけ記録して古くする。
    const sessions = orderRoutes._usageSessions;
    const session = {
      lastLenderHeartbeat: Date.now() - 60 * 60 * 1000,
      getUsageSeconds: () => 120,
      checkTimeouts: () => {},
    };
    sessions.set(order.id, session);
    orderRoutes._sweepHeartbeatSlaBreaches(Date.now());
    sessions.delete(order.id);
    assertPurged(order.id);
  });

  it('dispute resolved as a refund leaves no credential', async () => {
    const order = activeOrderWithAccess();
    const raised = await request(app).post(`/api/v1/orders/${order.id}/dispute`)
      .set('Authorization', `Bearer ${renter.token}`).send({ reason: 'GPU never responded to my jobs' });
    expect(raised.statusCode).toBe(201);
    const resolved = await request(app).post(`/api/v1/orders/${order.id}/dispute/resolve`)
      .set('Authorization', `Bearer ${admin.token}`).send({ decision: 'refund', note: 'renter is right' });
    expect(resolved.statusCode).toBe(200);
    assertPurged(order.id);
  });

  it('dispute resolved as upheld leaves no credential', async () => {
    const order = activeOrderWithAccess();
    await request(app).post(`/api/v1/orders/${order.id}/dispute`)
      .set('Authorization', `Bearer ${renter.token}`).send({ reason: 'I believe the GPU underperformed' });
    const resolved = await request(app).post(`/api/v1/orders/${order.id}/dispute/resolve`)
      .set('Authorization', `Bearer ${admin.token}`).send({ decision: 'uphold', note: 'work was delivered' });
    expect(resolved.statusCode).toBe(200);
    assertPurged(order.id);
  });

  it('an abandoned active order swept by the expiry job leaves no credential', () => {
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const order = activeOrderWithAccess({ startedAt: longAgo, durationMinutes: 5 });
    orderExpiry.expireStaleActiveOrders();
    assertPurged(order.id);
  });

  it('a dispute auto-resolved by the expiry job leaves no credential', () => {
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const order = activeOrderWithAccess();
    OrderRepository.update(order.id, {
      status: 'disputed', dispute: { reason: 'unanswered', raisedAt: longAgo, raisedBy: renter.id },
    });
    // disputed への遷移では消えない（まだ終端ではない）ことも同時に確かめる。
    expect(OrderRepository.getById(order.id).accessDelivery).toBeTruthy();
    orderExpiry.expireStaleDisputedOrders();
    assertPurged(order.id);
  });
});

// ─── 4. 修正前に終端へ落ちた注文の後追い ────────────────────────────────────
describe('purgeTerminalOrderCredentials picks up rows written before the invariant existed', () => {
  it('clears a terminal order that still holds a credential, and reports how many it cleared', () => {
    // beforeWrite を迂回して「修正前のファイル」を再現する（直接ファイルに書き戻す）。
    const order = OrderRepository.create({ userId: 'legacy', status: 'active', accessDelivery: SEALED() });
    const filePath = path.resolve(__dirname, '../../data/orders.json');
    const rows = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const idx = rows.findIndex((r) => r.id === order.id);
    rows[idx] = { ...rows[idx], status: 'completed' }; // 終端 + 認証情報あり = 修正前の状態
    fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
    expect(OrderRepository.getById(order.id).accessDelivery).toBeTruthy();

    const purged = orderExpiry.purgeTerminalOrderCredentials();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(OrderRepository.getById(order.id).accessDelivery).toBeNull();

    // 2 回目は何も残っていないので 0 件（掃除が空回りし続けない）。
    expect(orderExpiry.purgeTerminalOrderCredentials()).toBe(0);
  });
});
