// §5: プロバイダ担保ステーク API と出品ゲートの統合テスト。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const ReputationRepository = require('../../src/db/json/ReputationRepository');

const createdGpuIds = [];
const createdRepIds = [];

async function registerAndLogin(prefix, role = 'provider') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id };
}

const GPU_BODY = {
  name: 'Stake GPU', vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
  driverVersion: '550.54', os: 'Linux', arch: 'x86_64',
  memoryGB: 24, clockMHz: 2520, powerWatt: 450, pricePerHour: 500,
};

afterAll(() => {
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
  for (const id of createdRepIds) { try { ReputationRepository.delete(id); } catch (_) {} }
});

describe('provider stake (§5)', () => {
  it('deposits stake and reports balance via GET /marketplace/stake', async () => {
    const p = await registerAndLogin('stk');
    const dep = await request(app).post('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 100000 });
    expect(dep.statusCode).toBe(201);
    expect(dep.body.stake).toBe(100000);
    const rec = ReputationRepository.getByProviderId(p.id);
    if (rec) createdRepIds.push(rec.id);

    const get = await request(app).get('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`);
    expect(get.body.stake).toBe(100000);
    expect(get.body.canList).toBe(true); // MIN_PROVIDER_STAKE_SATS 未設定
  });

  it('rejects invalid stake amounts', async () => {
    const p = await registerAndLogin('stk');
    const res = await request(app).post('/api/v1/marketplace/stake')
      .set('Authorization', `Bearer ${p.token}`).send({ amountSats: -5 });
    expect(res.statusCode).toBe(400);
  });

  it('blocks GPU listing when stake < MIN_PROVIDER_STAKE_SATS, allows after deposit', async () => {
    process.env.MIN_PROVIDER_STAKE_SATS = '50000';
    try {
      const p = await registerAndLogin('stk');
      const blocked = await request(app).post('/api/v1/gpus')
        .set('Authorization', `Bearer ${p.token}`).send(GPU_BODY);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.body.stakeRequired).toBe(50000);

      await request(app).post('/api/v1/marketplace/stake')
        .set('Authorization', `Bearer ${p.token}`).send({ amountSats: 60000 });
      const ok = await request(app).post('/api/v1/gpus')
        .set('Authorization', `Bearer ${p.token}`).send(GPU_BODY);
      expect(ok.statusCode).toBe(201);
      createdGpuIds.push(ok.body.id || ok.body.gpu?.id);
      const rec = ReputationRepository.getByProviderId(p.id);
      if (rec) createdRepIds.push(rec.id);
    } finally {
      delete process.env.MIN_PROVIDER_STAKE_SATS;
    }
  });
});
