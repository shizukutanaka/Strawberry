// tests/api/gpu-carbon.test.js
// GET /gpus + /gpus/:id のカーボン強度と ?sort=carbon（研究ドキュメント §15）。
//
// 重点は「所在地を申告しない出品が最もグリーンに見えないこと」。強度不明を 0 扱いで
// 最上位に出すと、申告を省くのが最も有利になり、機能全体がグリーンウォッシングの道具になる。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');

const base = { vendor: 'NVIDIA', apiType: 'CUDA', model: 'RTX 4090', memoryGB: 24, powerWatt: 450, available: true };

describe('carbon on the GPU APIs', () => {
  it('reports intensity, tier and hourly emissions for a declared location', async () => {
    const gpu = GpuRepository.create({ ...base, name: `carbon-no-${Date.now()}`, pricePerHour: 1000, location: { country: 'NO' } });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.status).toBe(200);
    expect(res.body.gpu.carbon).toMatchObject({
      gCO2PerKWh: 30, tier: 'very_low', matched: 'NO', confidence: 'self-declared-location',
    });
    expect(res.body.gpu.carbon.gramsPerHour).toBeCloseTo(16.2, 1);
  });

  it('never presents the estimate as a verified green credential', async () => {
    // 所在地は自己申告。confidence を落とすと環境認証と誤読される。
    const gpu = GpuRepository.create({ ...base, name: `carbon-conf-${Date.now()}`, pricePerHour: 1000, location: { country: 'FR' } });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.body.gpu.carbon.confidence).toBe('self-declared-location');
  });

  it('reports unknown rather than guessing when no location is declared', async () => {
    const gpu = GpuRepository.create({ ...base, name: `carbon-none-${Date.now()}`, pricePerHour: 1000 });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.body.gpu.carbon.gCO2PerKWh).toBeNull();
    expect(res.body.gpu.carbon.gramsPerHour).toBeNull();
    expect(res.body.gpu.carbon.confidence).toBe('unknown');
  });

  it('includes carbon in the listing payload', async () => {
    const res = await request(app).get('/api/v1/gpus?limit=1');
    expect(res.status).toBe(200);
    if (res.body.gpus.length) expect(res.body.gpus[0].carbon).toBeDefined();
  });
});

describe('GET /gpus?sort=carbon', () => {
  const tag = `carbonsort-${Date.now()}`;
  let ids;

  beforeAll(() => {
    const dirty = GpuRepository.create({ ...base, name: `${tag}-pl`, pricePerHour: 100, location: { country: 'PL' } });
    const clean = GpuRepository.create({ ...base, name: `${tag}-no`, pricePerHour: 100, location: { country: 'NO' } });
    const unknown = GpuRepository.create({ ...base, name: `${tag}-unknown`, pricePerHour: 100 });
    ids = { dirty: dirty.id, clean: clean.id, unknown: unknown.id };
  });

  const orderOf = (body) => body.gpus.filter((g) => g.name.startsWith(tag)).map((g) => g.id);

  it('ranks low-carbon first and pushes unknown-location listings last', async () => {
    // 「不明」を最上位にすると、所在地を申告しないのが最も有利になってしまう
    const res = await request(app).get(`/api/v1/gpus?sort=carbon&search=${tag}&limit=200`);
    expect(res.status).toBe(200);
    expect(orderOf(res.body)).toEqual([ids.clean, ids.dirty, ids.unknown]);
  });

  it('leaves the default price sort untouched', async () => {
    const res = await request(app).get(`/api/v1/gpus?search=${tag}&limit=200`);
    expect(res.status).toBe(200);
    expect(orderOf(res.body)).toHaveLength(3);
  });
});
