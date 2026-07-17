// GET /gpus/:id/market-rate — median/min/max sats/hr among listings sharing the
// same `model`, computed from existing listing data (no new persistence).
// Public endpoint (no auth), matching /gpus and /gpus/:id/reviews.
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');

describe('GET /gpus/:id/market-rate', () => {
  it('404s for a nonexistent GPU', async () => {
    const res = await request(app).get('/api/v1/gpus/00000000-0000-4000-8000-000000000000/market-rate');
    expect(res.status).toBe(404);
  });

  it('counts the listing itself as sampleCount 1 when its model is otherwise unique', async () => {
    const gpu = GpuRepository.create({
      name: 'Unique GPU', vendor: 'NVIDIA', model: `RTX-UNIQUE-${Date.now()}`, memoryGB: 16, pricePerHour: 500,
    });
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}/market-rate`);
    expect(res.status).toBe(200);
    expect(res.body.sampleCount).toBe(1);
    expect(res.body.medianPricePerHour).toBe(500);
    expect(res.body.minPricePerHour).toBe(500);
    expect(res.body.maxPricePerHour).toBe(500);
  });

  it('computes median/min/max across listings sharing the same model', async () => {
    const model = `RTX-MARKET-${Date.now()}`;
    const prices = [800, 1000, 1200, 1500];
    let lastId;
    for (const pricePerHour of prices) {
      lastId = GpuRepository.create({
        name: `Market GPU ${pricePerHour}`, vendor: 'NVIDIA', model, memoryGB: 24, pricePerHour,
      }).id;
    }
    const res = await request(app).get(`/api/v1/gpus/${lastId}/market-rate`);
    expect(res.status).toBe(200);
    expect(res.body.sampleCount).toBe(4);
    // even count -> average of two middle values: (1000+1200)/2 = 1100
    expect(res.body.medianPricePerHour).toBe(1100);
    expect(res.body.minPricePerHour).toBe(800);
    expect(res.body.maxPricePerHour).toBe(1500);
  });

  it('does not mix different models together', async () => {
    const modelA = `RTX-A-${Date.now()}`;
    const modelB = `RTX-B-${Date.now()}`;
    GpuRepository.create({ name: 'A1', vendor: 'NVIDIA', model: modelA, memoryGB: 8, pricePerHour: 100 });
    GpuRepository.create({ name: 'A2', vendor: 'NVIDIA', model: modelA, memoryGB: 8, pricePerHour: 200 });
    const gpuB = GpuRepository.create({ name: 'B1', vendor: 'NVIDIA', model: modelB, memoryGB: 8, pricePerHour: 9000 });

    const res = await request(app).get(`/api/v1/gpus/${gpuB.id}/market-rate`);
    expect(res.status).toBe(200);
    expect(res.body.sampleCount).toBe(1);
    expect(res.body.medianPricePerHour).toBe(9000);
  });
});
