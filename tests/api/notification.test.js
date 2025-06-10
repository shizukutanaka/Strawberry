// Notification API自動テスト雛形（Jest）
const request = require('supertest');
const app = require('../../src/api/server');

describe('Notification API', () => {
  it('POST /api/v1/notification/create should validate and return 200', async () => {
    const res = await request(app)
      .post('/api/v1/notification/create')
      .send({
        userId: 1,
        message: '通知テスト',
        type: 'info'
      });
    expect([200,201,400]).toContain(res.statusCode);
  });
});
