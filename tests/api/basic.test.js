// API基本動作テスト雛形（Jest）
const request = require('supertest');
const app = require('../../src/api/server');

describe('API基本テスト', () => {
  it('GET /api/v1/gpu/search should return 200', async () => {
    const res = await request(app).get('/api/v1/gpu/search');
    expect(res.statusCode).toBe(200);
  });
});
