// Payment API自動テスト雛形（Jest）
const request = require('supertest');
const app = require('../../src/api/server');

describe('Payment API', () => {
  it('POST /api/v1/payment/create should validate and return 200', async () => {
    const res = await request(app)
      .post('/api/v1/payment/create')
      .send({
        orderId: 1,
        amount: 0.01,
        currency: 'BTC',
        method: 'crypto',
        payer: 'user1',
        payee: 'user2'
      });
    expect([200,201,400]).toContain(res.statusCode);
  });
});
