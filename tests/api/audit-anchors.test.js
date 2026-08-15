// tests/api/audit-anchors.test.js
// 監査ログの外部コミットメント API（研究ドキュメント §18）。
//
// 公開エンドポイントであることが要件そのもの: 第三者が commitment（Merkle root）と
// OTS レシートを保持していなければ、運営による後日の遡及改ざんを誰も検出できない。
// 逆にエントリ本体・包含証明は監査ログの中身を露出するので admin 限定でなければならない。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const anchorScheduler = require('../../src/security/anchor-scheduler');
const auditAnchor = require('../../src/security/audit-anchor');
const { appendAuditLog } = require('../../src/utils/audit-log');

const uniq = Date.now().toString(36);
let adminTok;
let userTok;

beforeAll(async () => {
  const admName = `anchadm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  UserRepository.update(UserRepository.getByEmail(admEmail).id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `anchusr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;

  // アンカーを 1 つ作っておく（他テストと同じ audit.log を共有するため、必ず新規エントリを足す）
  appendAuditLog('test_seed_for_anchor', { uniq }, 'test');
  await anchorScheduler.runOnce();
});

const asAdmin = (r) => r.set('Authorization', `Bearer ${adminTok}`);
const asUser = (r) => r.set('Authorization', `Bearer ${userTok}`);

describe('GET /audit-anchors/latest (public)', () => {
  it('serves the commitment without authentication — publishing it is the point', async () => {
    const res = await request(app).get('/api/v1/audit-anchors/latest');
    expect(res.status).toBe(200);
    expect(res.body.root).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.algorithm).toBe('sha256-merkle-v1');
    expect(typeof res.body.count).toBe('number');
    expect(typeof res.body.toIndex).toBe('number');
    expect(Array.isArray(res.body.ots)).toBe(true);
    // 第三者がどう検証すればよいかを応答自身が説明する
    expect(res.body.verify).toMatch(/ots verify/);
  });

  it('never exposes audit entry contents or byte offsets', async () => {
    const res = await request(app).get('/api/v1/audit-anchors/latest');
    expect(res.status).toBe(200);
    expect(res.body.entries).toBeUndefined();
    expect(res.body.fromByteOffset).toBeUndefined();
    expect(res.body.toByteOffset).toBeUndefined();
    // OTS の内訳に生レシートを混ぜない（レシートは専用エンドポイント）
    for (const o of res.body.ots) expect(o.receiptB64).toBeUndefined();
  });
});

describe('GET /audit-anchors/:root/receipt (public)', () => {
  it('rejects a malformed root', async () => {
    const res = await request(app).get('/api/v1/audit-anchors/not-a-root/receipt');
    expect(res.status).toBe(400);
  });

  it('404s for a well-formed root that has no receipt', async () => {
    const res = await request(app).get(`/api/v1/audit-anchors/${'b'.repeat(64)}/receipt`);
    expect(res.status).toBe(404);
  });
});

describe('admin endpoints', () => {
  it('requires admin for the anchor list', async () => {
    expect((await asUser(request(app).get('/api/v1/admin/audit-anchors'))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/audit-anchors')).status).toBe(401);
  });

  it('lists anchors newest-first for an admin', async () => {
    const res = await asAdmin(request(app).get('/api/v1/admin/audit-anchors?limit=5'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.anchors[0].root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires admin to force an anchor cycle', async () => {
    expect((await asUser(request(app).post('/api/v1/admin/audit-anchors/run'))).status).toBe(403);
  });

  it('runs a cycle on demand and reports honestly when there is nothing new', async () => {
    appendAuditLog('test_forced_cycle', { uniq }, 'test');
    const first = await asAdmin(request(app).post('/api/v1/admin/audit-anchors/run'));
    expect(first.status).toBe(201);
    expect(first.body.anchored).toBe(true);
    expect(first.body.anchor.root).toMatch(/^[0-9a-f]{64}$/);

    // 直後にもう一度: 自身の簿記エントリしか無いので何もアンカーしない
    const second = await asAdmin(request(app).post('/api/v1/admin/audit-anchors/run'));
    expect(second.status).toBe(200);
    expect(second.body.anchored).toBe(false);
    expect(second.body.reason).toBeTruthy();
  });

  it('returns a verifiable inclusion proof for an anchored entry', async () => {
    const anchor = auditAnchor.lastAnchor();
    const res = await asAdmin(request(app).get(`/api/v1/admin/audit-anchors/proof?index=${anchor.fromIndex}`));
    expect(res.status).toBe(200);
    expect(res.body.root).toBe(anchor.root);
    // 返された材料だけで第三者が root を再計算できること
    expect(auditAnchor.verifyEntryInclusion(res.body.entry, res.body.proof, res.body.root)).toBe(true);
  });

  it('detects a tampered entry against the anchored root', async () => {
    const anchor = auditAnchor.lastAnchor();
    const res = await asAdmin(request(app).get(`/api/v1/admin/audit-anchors/proof?index=${anchor.fromIndex}`));
    const tampered = { ...res.body.entry, detail: { hacked: true } };
    expect(auditAnchor.verifyEntryInclusion(tampered, res.body.proof, res.body.root)).toBe(false);
  });

  it('validates the index and 404s when no anchor covers it', async () => {
    expect((await asAdmin(request(app).get('/api/v1/admin/audit-anchors/proof?index=-1'))).status).toBe(400);
    expect((await asAdmin(request(app).get('/api/v1/admin/audit-anchors/proof?index=abc'))).status).toBe(400);
    expect((await asAdmin(request(app).get('/api/v1/admin/audit-anchors/proof?index=99999999'))).status).toBe(404);
  });

  it('does not treat the admin paths as public (no auth bypass via the public whitelist)', async () => {
    // routes/index.js のコメントが警告する構造的罠 — admin パスを公開扱いにしないこと
    expect((await request(app).get('/api/v1/admin/audit-anchors')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/audit-anchors/proof?index=0')).status).toBe(401);
    expect((await request(app).post('/api/v1/admin/audit-anchors/run')).status).toBe(401);
  });
});
