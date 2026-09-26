// §2: POST /gpus の benchmarkReport → specConsistency 記録の統合テスト。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const ReputationRepository = require('../../src/db/json/ReputationRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const createdGpuIds = [];
const createdRepIds = [];

async function registerAndLogin(prefix, role = 'provider') {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', role });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email).id };
}

const GPU_BODY = {
  name: 'Spec GPU', vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
  driverVersion: '550.54', os: 'Linux', arch: 'x86_64',
  memoryGB: 24, clockMHz: 2520, powerWatt: 450, pricePerHour: 500,
  performance: { teraflops: 82.6, benchmarkScore: 34000 },
};

afterAll(() => {
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
  for (const id of createdRepIds) { try { ReputationRepository.delete(id); } catch (_) {} }
});

describe('GPU spec consistency (§2)', () => {
  it('records specConsistency=consistent for a faithful benchmark report', async () => {
    const p = await registerAndLogin('spc');
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${p.token}`)
      .send({
        ...GPU_BODY,
        benchmarkReport: {
          model: 'RTX 4090', memoryGB: 24, teraflops: 80, benchmarkScore: 33500,
          signature: 'sig-abcdef0123', timestamp: new Date().toISOString(),
        },
      });
    expect(res.statusCode).toBe(201);
    const gpu = res.body.gpu || res.body;
    createdGpuIds.push(gpu.id);
    expect(gpu.specConsistency).toBeTruthy();
    expect(gpu.specConsistency.label).toBe('consistent');
  });

  it('labels spoofed specs suspicious and records attestation fail on reputation', async () => {
    const p = await registerAndLogin('spc');
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${p.token}`)
      .send({
        ...GPU_BODY,
        benchmarkReport: {
          model: 'RTX 3060', memoryGB: 12, teraflops: 12.7, benchmarkScore: 17000,
          signature: 'sig-abcdef0123', timestamp: new Date().toISOString(),
        },
      });
    expect(res.statusCode).toBe(201);
    const gpu = res.body.gpu || res.body;
    createdGpuIds.push(gpu.id);
    expect(gpu.specConsistency.label).toBe('suspicious');
    const rep = ReputationRepository.getByProviderId(p.id);
    if (rep) createdRepIds.push(rep.id);
    expect(rep && rep.stats.attestationFails >= 1).toBe(true);
  });

  it('omits specConsistency when no benchmarkReport is provided', async () => {
    const p = await registerAndLogin('spc');
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${p.token}`).send(GPU_BODY);
    expect(res.statusCode).toBe(201);
    const gpu = res.body.gpu || res.body;
    createdGpuIds.push(gpu.id);
    expect(gpu.specConsistency).toBeUndefined();
  });
});
