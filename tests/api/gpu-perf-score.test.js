// GET /gpus + /gpus/:id — 正規化性能スコア（performanceScore）と ?sort=perf|value。
// 借り手が「どの GPU が速いか / 一番お得か」を機種横断で比較できるようにする増分。
// 公開エンドポイント（認証不要）で、既存の rating/reliability と同じ扱い。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');

const base = { vendor: 'NVIDIA', apiType: 'CUDA', available: true };

describe('performanceScore on the GPU APIs', () => {
  it('exposes a score, confidence and price-performance on the listing', async () => {
    const gpu = GpuRepository.create({
      ...base, name: `perf-4090-${Date.now()}`, model: 'NVIDIA GeForce RTX 4090',
      memoryGB: 24, powerWatt: 450, pricePerHour: 1000,
    });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.status).toBe(200);
    const p = res.body.gpu.performanceScore;
    expect(p.score).toBe(100);
    expect(p.confidence).toBe('reference');
    expect(p.matchedModel).toBe('rtx 4090');
    expect(p.perfPerHourSat).toBe(0.1);
    // 詳細ページは根拠まで開示する
    expect(p.basis.source).toBe('model-table:rtx 4090');
    expect(p.findings).toEqual([]);
  });

  it('surfaces a spec-fraud finding and withholds the score when the model contradicts the VRAM', async () => {
    const gpu = GpuRepository.create({
      ...base, name: `perf-fraud-${Date.now()}`, model: 'H100',
      memoryGB: 24, powerWatt: 250, pricePerHour: 9000,
    });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(res.status).toBe(200);
    const p = res.body.gpu.performanceScore;
    // 「H100」を名乗るだけで H100 のスコアが付いてはならない
    expect(p.score).toBeNull();
    expect(p.findings.some((f) => f.startsWith('vram_mismatch'))).toBe(true);
  });

  it('keeps the listing payload compact (no basis/findings in the list view)', async () => {
    const res = await request(app).get('/api/v1/gpus?limit=1');
    expect(res.status).toBe(200);
    if (res.body.gpus.length) {
      const p = res.body.gpus[0].performanceScore;
      expect(p).toBeDefined();
      expect(Object.keys(p).sort()).toEqual(['confidence', 'matchedModel', 'perfPerHourSat', 'score']);
    }
  });

  it('does not leak providerId through the listing', async () => {
    const res = await request(app).get('/api/v1/gpus?limit=5');
    expect(res.status).toBe(200);
    for (const g of res.body.gpus) expect(g.providerId).toBeUndefined();
  });
});

describe('GET /gpus?sort=perf|value', () => {
  // 同一 tag の GPU 群だけを取り出して順序を検証する（他テストが作る GPU と混ざるため）
  const tag = `sorttest-${Date.now()}`;
  let ids;

  beforeAll(() => {
    const slow = GpuRepository.create({
      ...base, name: `${tag}-t4`, model: 'Tesla T4', memoryGB: 16, powerWatt: 70, pricePerHour: 100,
    });
    const fast = GpuRepository.create({
      ...base, name: `${tag}-h100`, model: 'H100 SXM', memoryGB: 80, powerWatt: 700, pricePerHour: 100000,
    });
    const unknown = GpuRepository.create({
      ...base, name: `${tag}-unknown`, model: 'Unknown 9000', memoryGB: 48, pricePerHour: 50,
    });
    ids = { slow: slow.id, fast: fast.id, unknown: unknown.id };
  });

  const orderOf = (body) => body.gpus.filter((g) => g.name.startsWith(tag)).map((g) => g.id);

  it('sort=perf ranks by raw performance, pushing unscored listings last', async () => {
    const res = await request(app).get(`/api/v1/gpus?sort=perf&search=${tag}&limit=200`);
    expect(res.status).toBe(200);
    expect(orderOf(res.body)).toEqual([ids.fast, ids.slow, ids.unknown]);
  });

  it('sort=value ranks by price-performance, so the cheap GPU beats the overpriced flagship', async () => {
    const res = await request(app).get(`/api/v1/gpus?sort=value&search=${tag}&limit=200`);
    expect(res.status).toBe(200);
    expect(orderOf(res.body)).toEqual([ids.slow, ids.fast, ids.unknown]);
  });

  it('leaves the default price sort untouched', async () => {
    const res = await request(app).get(`/api/v1/gpus?search=${tag}&limit=200`);
    expect(res.status).toBe(200);
    expect(orderOf(res.body)).toEqual([ids.unknown, ids.slow, ids.fast]);
  });
});
