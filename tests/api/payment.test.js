// Payment API セキュリティ契約テスト（Jest）
// 注: 旧テストは無認証で /api/v1/payment/create が 200 を返す前提だったが、
// 実際の決済ルートは /api/v1/payments であり、かつ全 /api/v1/* は
// グローバル JWT ゲート(routes/index.js)で保護される。資金に直結する決済系は
// 無認証アクセスを必ず拒否すべき——その契約をここで固定する（セキュリティ回帰防止）。
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('Payment API security', () => {
  it('rejects unauthenticated payment requests with 401', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .send({ orderId: 1, amount: 0.01, currency: 'BTC', method: 'crypto' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unauthenticated access to the legacy create path too', async () => {
    const res = await request(app)
      .post('/api/v1/payment/create')
      .send({ orderId: 1, amount: 0.01 });
    expect(res.statusCode).toBe(401);
  });
});
