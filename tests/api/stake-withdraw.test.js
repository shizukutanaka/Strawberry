// §5 残件: marketplace stake 出金 API（アンボンディング）の統合テスト。
const request = require('supertest');
const { app } = require('../../src/api/server');
const ReputationRepository = require('../../src/db/json/ReputationRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const repIds = [];

async function registerAndLogin(prefix, role = 'provider') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email).id };
}

afterAll(() => {
  for (const id of repIds) { try { ReputationRepository.delete(id); } catch (_) {} }
});

describe('marketplace stake withdrawal (§5)', () => {
  it('deposit → withdraw request (202 pending) → claim before unbond releases 0', async () => {
    const p = await registerAndLogin('wd');
    const dep = await request(app).post('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 5000 });
    expect(dep.statusCode).toBe(201);
    repIds.push(ReputationRepository.getByProviderId(p.id)?.id);

    const wd = await request(app).post('/api/v1/marketplace/stake/withdraw')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 3000 });
    expect(wd.statusCode).toBe(202);
    expect(wd.body.withdrawal.eligibleAt).toBeTruthy();

    const claim = await request(app).post('/api/v1/marketplace/stake/claim')
      .set('Authorization', `Bearer ${p.token}`).send({});
    expect(claim.body.releasedSats).toBe(0);

    const st = await request(app).get('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`);
    expect(st.body.stake).toBe(5000);
    expect(st.body.pendingWithdrawals).toHaveLength(1);
  });

  it('rejects over-withdrawal and invalid amounts', async () => {
    const p = await registerAndLogin('wd');
    await request(app).post('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 1000 });
    repIds.push(ReputationRepository.getByProviderId(p.id)?.id);
    const over = await request(app).post('/api/v1/marketplace/stake/withdraw')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 5000 });
    expect(over.statusCode).toBe(409);
    const bad = await request(app).post('/api/v1/marketplace/stake/withdraw')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: -5 });
    expect(bad.statusCode).toBe(400);
    const badDep = await request(app).post('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 0 });
    expect(badDep.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/v1/marketplace/stake').send({ amountSats: 1 })).statusCode).toBe(401);
    expect((await request(app).get('/api/v1/marketplace/stake')).statusCode).toBe(401);
  });
});
