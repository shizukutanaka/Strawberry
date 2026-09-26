// Carbon-aware placement (§15) API tests.
// Two surfaces:
//  1. GET /gpus — ?green / ?maxCarbonIntensity filters, ?sort=carbon ordering,
//     and the `green` flag on listed GPUs (undisclosed providers are never green).
//  2. POST /marketplace/auction — the renter-facing `opts` whitelist
//     (weights.carbon / maxCarbonIntensity) actually reaches the engine.

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const created = [];
function makeGpu(attrs) {
  const g = GpuRepository.create({
    name: `gpu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    vendor: 'NVIDIA', model: 'RTX-C', memoryGB: 16,
    pricePerHour: 10, providerId: `prov-${Date.now()}`, available: true,
    ...attrs,
  });
  created.push(g.id);
  return g;
}

afterAll(() => {
  for (const id of created) GpuRepository.delete(id);
});

describe('GET /gpus carbon filters (§15)', () => {
  it('green=true keeps only disclosed low-carbon GPUs and flags them', async () => {
    const green = makeGpu({ location: { country: 'JP', carbonIntensity: 30 } });
    makeGpu({ location: { country: 'JP', carbonIntensity: 800 } });
    makeGpu({ location: { country: 'JP' } }); // undisclosed

    const res = await request(app).get('/api/v1/gpus?green=true&limit=200');
    expect(res.statusCode).toBe(200);
    const ids = res.body.gpus.map(g => g.id);
    expect(ids).toContain(green.id);
    for (const g of res.body.gpus) {
      expect(g.green).toBe(true);
      expect(g.location.carbonIntensity).toBeLessThanOrEqual(200);
    }
  });

  it('maxCarbonIntensity filters by disclosed intensity and rejects bad input', async () => {
    const ok = makeGpu({ location: { carbonIntensity: 100 } });
    makeGpu({ location: { carbonIntensity: 700 } });
    makeGpu({}); // no location

    const res = await request(app).get('/api/v1/gpus?maxCarbonIntensity=200&limit=200');
    expect(res.statusCode).toBe(200);
    const ids = res.body.gpus.map(g => g.id);
    expect(ids).toContain(ok.id);
    for (const g of res.body.gpus) {
      expect(g.location.carbonIntensity).toBeLessThanOrEqual(200);
    }

    const bad = await request(app).get('/api/v1/gpus?maxCarbonIntensity=-5');
    expect(bad.statusCode).toBe(400);
  });

  it('sort=carbon orders low-to-high with undisclosed last', async () => {
    const low = makeGpu({ location: { carbonIntensity: 20 } });
    const high = makeGpu({ location: { carbonIntensity: 900 } });
    const hidden = makeGpu({}); // undisclosed

    const res = await request(app).get('/api/v1/gpus?sort=carbon&limit=200');
    expect(res.statusCode).toBe(200);
    const pos = {};
    res.body.gpus.forEach((g, i) => { if ([low.id, high.id, hidden.id].includes(g.id)) pos[g.id] = i; });
    expect(pos[low.id]).toBeLessThan(pos[high.id]);
    expect(pos[high.id]).toBeLessThan(pos[hidden.id]);
  });
});

describe('POST /marketplace/auction carbon opts (§15)', () => {
  let token;
  beforeAll(async () => {
    const u = `carbon${Date.now().toString(36)}`.slice(0, 20);
    await request(app).post('/api/v1/users/register')
      .send({ username: u, email: `${u}@example.com`, password: 'Test1234!', role: 'provider' });
    const login = await request(app).post('/api/v1/users/login')
      .send({ email: `${u}@example.com`, password: 'Test1234!' });
    token = login.body.token;
  });

  it('weights.carbon shifts the winner to the low-carbon bidder', async () => {
    const res = await request(app).post('/api/v1/marketplace/auction')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bids: [
          { providerId: 'dirty', pricePerHour: 100, reputationScore: 0.8, carbonIntensity: 800 },
          { providerId: 'green', pricePerHour: 110, reputationScore: 0.8, carbonIntensity: 40 },
        ],
        opts: { weights: { price: 0.2, reputation: 0.2, sla: 0.1, attestation: 0, carbon: 0.5 } },
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.winner.providerId).toBe('green');
    expect(res.body.ranked.find(r => r.providerId === 'green').green).toBe(true);
  });

  it('maxCarbonIntensity rejects high-carbon bids end-to-end', async () => {
    const res = await request(app).post('/api/v1/marketplace/auction')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bids: [
          { providerId: 'dirty', pricePerHour: 80, reputationScore: 0.9, carbonIntensity: 900 },
          { providerId: 'green', pricePerHour: 100, reputationScore: 0.8, carbonIntensity: 50 },
        ],
        opts: { maxCarbonIntensity: 200 },
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.winner.providerId).toBe('green');
    expect(res.body.rejected.find(r => r.providerId === 'dirty').reasons)
      .toContain('over max carbon intensity');
  });

  it('ignores non-whitelisted and malformed opts', async () => {
    const res = await request(app).post('/api/v1/marketplace/auction')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bids: [{ providerId: 'a', pricePerHour: 100, reputationScore: 0.5 }],
        opts: { evil: 'x', weights: { carbon: 'lots', price: 999 }, reservePrice: 'high' },
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.winner.providerId).toBe('a');
  });
});
