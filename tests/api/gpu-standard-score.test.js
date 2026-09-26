// §12: 標準スコア（DLPerf 相当）が GPU 一覧/詳細に露出し、
// sort=standard / minStandardScore でフィルタ・順位付けできることの API 統合テスト。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');

const createdGpuIds = [];

function mkGpu(model, extra = {}) {
  const gpu = GpuRepository.create({
    name: `score-${model}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
    vendor: 'NVIDIA', model, memoryGB: 24,
    pricePerHour: 10, providerId: `p-${Date.now().toString(36)}`,
    ...extra,
  });
  createdGpuIds.push(gpu.id);
  return gpu;
}

afterAll(() => {
  for (const id of createdGpuIds) { try { GpuRepository.delete(id); } catch (_) {} }
});

describe('GPU standard score (§12 DLPerf-equivalent)', () => {
  it('surfaces standardScore on list and detail for known models; null for unknown', async () => {
    const g4090 = mkGpu('NVIDIA GeForce RTX 4090');
    const gT4 = mkGpu('Tesla T4');
    const gMyst = mkGpu('NoSuch Accelerator X1');

    const list = await request(app).get('/api/v1/gpus?limit=200');
    expect(list.statusCode).toBe(200);
    const row4090 = list.body.gpus.find(g => g.id === g4090.id);
    const rowT4 = list.body.gpus.find(g => g.id === gT4.id);
    const rowM = list.body.gpus.find(g => g.id === gMyst.id);
    expect(row4090.standardScore).toBeCloseTo(1.0, 2);
    expect(row4090.standardScoreModel).toBe('RTX 4090');
    expect(rowT4.standardScore).toBeGreaterThan(0);
    expect(rowT4.standardScore).toBeLessThan(row4090.standardScore);
    expect(rowM.standardScore).toBeNull();

    const detail = await request(app).get(`/api/v1/gpus/${g4090.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.gpu.standardScore).toBeCloseTo(1.0, 2);
  });

  it('sorts by ?sort=standard with unknown models last', async () => {
    const gT4 = mkGpu('Tesla T4');
    const gH100 = mkGpu('NVIDIA H100 PCIe');
    const gMyst = mkGpu('ZZZ Unknown 1');

    const list = await request(app).get('/api/v1/gpus?sort=standard&limit=200');
    expect(list.statusCode).toBe(200);
    const rows = list.body.gpus;
    const iH = rows.findIndex(g => g.id === gH100.id);
    const iT = rows.findIndex(g => g.id === gT4.id);
    const iM = rows.findIndex(g => g.id === gMyst.id);
    expect(iH).toBeGreaterThanOrEqual(0);
    expect(iT).toBeGreaterThanOrEqual(0);
    expect(iM).toBeGreaterThanOrEqual(0);
    expect(iH).toBeLessThan(iT);
    expect(iT).toBeLessThan(iM); // 未知機種は末尾
  });

  it('filters by ?minStandardScore and validates range', async () => {
    const g4090 = mkGpu('RTX 4090');
    const gT4 = mkGpu('Tesla T4');

    const list = await request(app).get('/api/v1/gpus?minStandardScore=0.9&limit=200');
    expect(list.statusCode).toBe(200);
    const ids = list.body.gpus.map(g => g.id);
    expect(ids).toContain(g4090.id);
    expect(ids).not.toContain(gT4.id);

    const bad = await request(app).get('/api/v1/gpus?minStandardScore=abc');
    expect(bad.statusCode).toBe(400);
    const neg = await request(app).get('/api/v1/gpus?minStandardScore=-1');
    expect(neg.statusCode).toBe(400);
  });
});
