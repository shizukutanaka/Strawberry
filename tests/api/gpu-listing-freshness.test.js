// GPU 出品鮮度: POST /gpus/heartbeat でプロバイダ生存を刻印し、
// TTL (GPU_HEARTBEAT_TTL_MS) 超過の出品を一覧で stale + available=false にする。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerProvider(tag) {
  const u = `staleprov${tag}${Date.now().toString(36)}`.slice(0, 20);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!', role: 'provider' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  const providerId = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`).id;
  return { token: login.body.token, providerId };
}

describe('GPU listing freshness (provider heartbeat)', () => {
  test('heartbeat で出品が新鮮になり、TTL 超過で stale→unavailable になる', async () => {
    const { token, providerId } = await registerProvider('a');
    const gpu = GpuRepository.create({
      name: `Fresh-${Date.now()}`, vendor: 'NVIDIA', model: 'RTX-FRESH', memoryGB: 8,
      pricePerHour: 10, providerId, createdAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    // createdAt が 1h 前（TTL 10min 超過）→ heartbeat 前は stale
    let list = await request(app).get('/api/v1/gpus?limit=200');
    let entry = list.body.gpus.find(g => g.id === gpu.id);
    expect(entry.stale).toBe(true);
    expect(entry.available).toBe(false);
    expect(entry.lastProviderHeartbeat).toBeUndefined(); // 公開面に漏れない

    const hb = await request(app).post('/api/v1/gpus/heartbeat')
      .set('Authorization', `Bearer ${token}`);
    expect(hb.statusCode).toBe(200);
    expect(hb.body.updated).toBeGreaterThanOrEqual(1);

    list = await request(app).get('/api/v1/gpus?limit=200');
    entry = list.body.gpus.find(g => g.id === gpu.id);
    expect(entry.stale).toBe(false);
    expect(entry.available).toBe(true);
  });

  test('他プロバイダの GPU は heartbeat の影響を受けない', async () => {
    const a = await registerProvider('b');
    const b = await registerProvider('c');
    const gpuA = GpuRepository.create({
      name: `A-${Date.now()}`, vendor: 'NVIDIA', model: 'RTX-A', memoryGB: 8,
      pricePerHour: 10, providerId: a.providerId,
      createdAt: new Date().toISOString(),
    });
    const gpuB = GpuRepository.create({
      name: `B-${Date.now()}`, vendor: 'NVIDIA', model: 'RTX-B', memoryGB: 8,
      pricePerHour: 10, providerId: b.providerId,
      createdAt: new Date(Date.now() - 3600_000).toISOString(), // stale anchor
    });
    const hb = await request(app).post('/api/v1/gpus/heartbeat')
      .set('Authorization', `Bearer ${a.token}`);
    expect(hb.body.updated).toBe(1);
    const list = await request(app).get('/api/v1/gpus?limit=200');
    expect(list.body.gpus.find(g => g.id === gpuA.id).stale).toBe(false);
    expect(list.body.gpus.find(g => g.id === gpuB.id).stale).toBe(true);
  });

  test('未認証・renter は heartbeat できない', async () => {
    const unauth = await request(app).post('/api/v1/gpus/heartbeat');
    expect([401, 403]).toContain(unauth.statusCode);
  });
});
