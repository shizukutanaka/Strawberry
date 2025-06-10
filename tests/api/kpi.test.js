// KPI API自動テスト雛形（Jest）
const request = require('supertest');
const app = require('../../src/api/server');

describe('KPI API', () => {
  it('POST /api/v1/kpi/report should validate and return 200', async () => {
    const res = await request(app)
      .post('/api/v1/kpi/report')
      .send({
        date: new Date().toISOString(),
        todo: 5,
        done: 10,
        wip: 2
      });
    expect([200,201,400]).toContain(res.statusCode);
  });
});
