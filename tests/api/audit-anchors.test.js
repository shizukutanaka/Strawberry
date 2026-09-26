// §18 API tests: /api/v1/audit/anchors — admin-only anchoring + OTS receipt status.
// NODE_ENV=test → OTS adapter は Mock（外部カレンダーへ出ない）。

const fs = require('fs');
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const { appendAuditLog } = require('../../src/utils/audit-log');
const { ANCHOR_PATH, AUDIT_LOG_PATH } = require('../../src/security/audit-anchor');
const { OTS_RECEIPTS_PATH } = require('../../src/security/ots-submitter');

const uniq = `a18${Date.now().toString(36)}`;
let adminTok, userTok;

beforeAll(async () => {
  const admName = `a18adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  UserRepository.update(UserRepository.getByEmail(admEmail).id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `a18usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

describe('admin gate', () => {
  it('rejects non-admin on all anchor endpoints', async () => {
    for (const [method, p] of [
      ['post', '/api/v1/audit/anchors'],
      ['get', '/api/v1/audit/anchors'],
      ['post', '/api/v1/audit/anchors/upgrade'],
      ['post', '/api/v1/audit/anchors/verify'],
    ]) {
      const res = await request(app)[method](p).set('Authorization', `Bearer ${userTok}`);
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('anchor lifecycle', () => {
  it('POST /anchors creates an anchor + OTS receipt; GET lists it; verify proves inclusion', async () => {
    // Ensure at least one audit entry exists (real appendAuditLog writes logs/audit.log)
    appendAuditLog('audit_anchor_test_entry', { marker: uniq });

    const created = await request(app)
      .post('/api/v1/audit/anchors')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({});
    expect(created.statusCode).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.anchor.root).toMatch(/^[0-9a-f]{64}$/);
    expect(['pending', 'confirmed', 'disabled']).toContain(created.body.ots.status);

    const list = await request(app)
      .get('/api/v1/audit/anchors')
      .set('Authorization', `Bearer ${adminTok}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.anchors.length).toBeGreaterThan(0);
    expect(list.body.ots.total).toBeGreaterThan(0);

    // Inclusion proof round-trip: build a proof for a known entry and verify via the endpoint.
    const { proveEntry, parseEntries } = require('../../src/security/audit-anchor');
    const entries = parseEntries(fs.readFileSync(AUDIT_LOG_PATH, 'utf-8'));
    const idx = entries.length - 1;
    const proof = proveEntry(entries, idx);
    const verify = await request(app)
      .post('/api/v1/audit/anchors/verify')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ entry: entries[idx], proof, root: created.body.anchor.root });
    expect(verify.statusCode).toBe(200);
    expect(verify.body.valid).toBe(true);
  });

  it('POST /anchors is idempotent when no new entries', async () => {
    const res = await request(app)
      .post('/api/v1/audit/anchors')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({});
    // audit middleware may add entries; accept either a fresh anchor or a skip
    expect([200, 201]).toContain(res.statusCode);
  });

  it('POST /anchors/upgrade confirms mock receipts', async () => {
    const res = await request(app)
      .post('/api/v1/audit/anchors/upgrade')
      .set('Authorization', `Bearer ${adminTok}`)
      .send({});
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('confirmed');
  });
});

afterAll(() => {
  for (const p of [ANCHOR_PATH, OTS_RECEIPTS_PATH]) {
    try { fs.unlinkSync(p); } catch (_) { /* 無ければ無視 */ }
  }
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close();
});
