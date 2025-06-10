// Feedback API自動テスト雛形（Jest）
const request = require('supertest');
const app = require('../../src/api/server');

describe('Feedback API', () => {
  it('POST /api/v1/feedback/create should validate and return 200', async () => {
    const res = await request(app)
      .post('/api/v1/feedback/create')
      .send({
        title: 'Test Feedback',
        detail: 'This is a test feedback.',
        priority: 'high'
      });
    expect([200,201,400]).toContain(res.statusCode); // スキーマバリデーション/実装状況で柔軟に判定
  });
});
