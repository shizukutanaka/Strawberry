// Order-scoped job verification tests (§1 Proof-of-Compute ルート配線).
//
// Covers:
//  - heartbeat の utilizationPct が検証レコードへ蓄積される（実ジョブ収集）
//  - output / replica 投入 → admin finalize → verdict + reputation 反映
//  - ゼロ負荷検出（利用率サンプルが全て閾値未満 → failed）
//  - /stop 時の自動 finalize（pending レコードがあれば verdict を確定）
//  - 権限: 当事者以外 403、プロバイダ自身の replica 403、非 admin finalize 403

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const VerificationRepository = require('../../src/db/json/VerificationRepository');

const createdOrderIds = [];
const createdGpuIds = [];
const createdVerifIds = [];

async function registerAndLogin(prefix, role = 'user') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return {
    token: login.body.token,
    id: login.body.user?.id || UserRepository.getByEmail(email).id,
    email,
  };
}

// JWT には role が焼き付くため、昇格は login 前に行う必要がある。
async function registerAdmin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role: 'user' });
  UserRepository.update(UserRepository.getByEmail(email).id, { role: 'admin' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email).id };
}

function mkGpu(providerId) {
  const gpu = GpuRepository.create({
    name: 'Verif GPU', vendor: 'NVIDIA', model: 'RTX-VFY', memoryGB: 8,
    pricePerHour: 10, providerId,
  });
  createdGpuIds.push(gpu.id);
  return gpu;
}

function mkOrder({ userId, providerId, gpuId, status = 'active' }) {
  const order = OrderRepository.create({
    gpuId, userId, providerId, status,
    durationMinutes: 60, pricePerHour: 10, totalPrice: 10,
  });
  createdOrderIds.push(order.id);
  return order;
}

afterAll(() => {
  for (const id of createdVerifIds) { try { VerificationRepository.delete(id); } catch (_) {} }
  for (const id of createdOrderIds) { try { OrderRepository.delete(id); } catch (_) {} }
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
});

function trackVerif(orderId) {
  const rec = VerificationRepository.getByJobId(orderId);
  if (rec) createdVerifIds.push(rec.id);
  return rec;
}

describe('order-scoped job verification (§1 route wiring)', () => {
  it('records lender heartbeat utilizationPct samples into a lazily-opened verification record', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    const hb = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ role: 'lender', utilizationPct: 42 });
    expect(hb.statusCode).toBe(200);

    const rec = trackVerif(order.id);
    expect(rec).toBeTruthy();
    expect(rec.utilSamples).toEqual([42]);
    expect(rec.providerId).toBe(provider.id);
    expect(rec.verdict).toBe('pending');
  });

  it('rejects a malformed utilizationPct with 400', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    const hb = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ role: 'lender', utilizationPct: 150 });
    expect(hb.statusCode).toBe(400);
  });

  it('finalizes verified when primary output matches the replica, and audits the provider reputation', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const auditor = await registerAndLogin('va', 'provider');
    const admin = await registerAdmin('vadm');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    // primary output (renter 観測値) + 独立プロバイダの replica が一致
    const out = await request(app).post(`/api/v1/orders/${order.id}/verify/output`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ output: [1, 2, 3.5] });
    expect(out.statusCode).toBe(200);

    const rep = await request(app).post(`/api/v1/orders/${order.id}/verify/replica`)
      .set('Authorization', `Bearer ${auditor.token}`)
      .send({ output: [1, 2, 3.5] });
    expect(rep.statusCode).toBe(200);
    expect(rep.body.replicas).toBe(1);

    const fin = await request(app).post(`/api/v1/orders/${order.id}/verify/finalize`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(fin.statusCode).toBe(200);
    expect(fin.body.verdict).toBe('verified');
    expect(fin.body.verificationCtx.verified).toBe(true);
    trackVerif(order.id);
  });

  it('finalizes failed when the replica output differs beyond tolerance', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const auditor = await registerAndLogin('va', 'provider');
    const admin = await registerAdmin('vadm');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    // auditRate=1 で必ず監査対象にする（既定10%サンプリングでは verdict が非決定的になる）
    await request(app).post(`/api/v1/orders/${order.id}/verify/output`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ output: [1, 2, 3], auditRate: 1 });
    await request(app).post(`/api/v1/orders/${order.id}/verify/replica`)
      .set('Authorization', `Bearer ${auditor.token}`)
      .send({ output: [9, 9, 9] });

    const fin = await request(app).post(`/api/v1/orders/${order.id}/verify/finalize`)
      .set('Authorization', `Bearer ${admin.token}`).send({});
    expect(fin.statusCode).toBe(200);
    expect(fin.body.verdict).toBe('failed');
    trackVerif(order.id);
  });

  it('detects zero-load from heartbeat utilization samples on finalize', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const admin = await registerAdmin('vadm');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    const hb = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ role: 'lender', utilizationPct: 0 });
    expect(hb.statusCode).toBe(200);
    trackVerif(order.id);

    // 課金されているのに利用率が実質ゼロ → ゼロ負荷の疑いで failed
    const fin = await request(app).post(`/api/v1/orders/${order.id}/verify/finalize`)
      .set('Authorization', `Bearer ${admin.token}`).send({});
    expect(fin.statusCode).toBe(200);
    expect(fin.body.verdict).toBe('failed');
    expect(fin.body.verificationCtx.suspectedZeroLoad).toBe(true);
  });

  it('auto-finalizes a pending record on /stop and returns the verdict', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const admin = await registerAdmin('vadm');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    // 健全な稼働サンプルだけ → finalize で verified（非監査 or 監査でも primary 不要ではないが
    // audited ジョブは primary/replica なしで inconclusive。レコードは audited 決定に依存するため
    // ここでは確定することだけを検証し、verdict 値の固定は行わない）。
    const hb = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ role: 'lender', utilizationPct: 80 });
    expect(hb.statusCode).toBe(200);
    const rec = trackVerif(order.id);
    expect(rec.utilSamples).toEqual([80]);

    const stop = await request(app).post(`/api/v1/orders/${order.id}/stop`)
      .set('Authorization', `Bearer ${admin.token}`).send({});
    expect(stop.statusCode).toBe(200);
    expect(stop.body.verification).not.toBeNull();
    const saved = VerificationRepository.getByJobId(order.id);
    expect(['verified', 'inconclusive', 'failed']).toContain(saved.verdict);
    expect(saved.verdict).not.toBe('pending');
  });

  it('enforces access control: non-party cannot read; primary provider cannot self-audit; non-admin cannot finalize', async () => {
    const provider = await registerAndLogin('vp', 'provider');
    const renter = await registerAndLogin('vr');
    const stranger = await registerAndLogin('vs');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    // 無関係ユーザーは当事者ではない → 403
    const g = await request(app).get(`/api/v1/orders/${order.id}/verification`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(g.statusCode).toBe(403);

    // 当事者は読める（レコード無しなら null）
    const g2 = await request(app).get(`/api/v1/orders/${order.id}/verification`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(g2.statusCode).toBe(200);
    expect(g2.body.verification).toBeNull();

    // プロバイダ自身は自己監査できない → 403
    const selfAudit = await request(app).post(`/api/v1/orders/${order.id}/verify/replica`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ output: [1] });
    expect(selfAudit.statusCode).toBe(403);

    // 非 provider ロールは replica を出せない → 403
    const nonProv = await request(app).post(`/api/v1/orders/${order.id}/verify/replica`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ output: [1] });
    expect(nonProv.statusCode).toBe(403);

    // 非 admin は finalize できない → 403
    const fin = await request(app).post(`/api/v1/orders/${order.id}/verify/finalize`)
      .set('Authorization', `Bearer ${renter.token}`).send({});
    expect(fin.statusCode).toBe(403);
  });

  it('returns 404 for verification of a nonexistent order and for finalize with no record', async () => {
    const admin = await registerAdmin('vadm');
    const renter = await registerAndLogin('vr');
    const provider = await registerAndLogin('vp', 'provider');
    const gpu = mkGpu(provider.id);
    const order = mkOrder({ userId: renter.id, providerId: provider.id, gpuId: gpu.id });

    const nf = await request(app).get(`/api/v1/orders/${'00000000-0000-4000-8000-000000000000'}/verification`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(nf.statusCode).toBe(404);

    const fin = await request(app).post(`/api/v1/orders/${order.id}/verify/finalize`)
      .set('Authorization', `Bearer ${admin.token}`).send({});
    expect(fin.statusCode).toBe(404);
  });
});
