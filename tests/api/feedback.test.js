// Feedback API テスト（Jest）
// 注: /api/v1/feedback/create エンドポイントは未実装（aspirational）。旧テストは無認証で
// 200 を期待していたが、全 /api/v1/* はグローバル JWT ゲートで保護される。ここでは
// 「未実装パスであっても無認証アクセスは 401 で遮断される」という多層防御の契約を固定する。
// 機能本体を実装する際は、認証済みの正常系/異常系をここに追加すること。
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('Feedback API', () => {
  it('rejects unauthenticated requests with 401 (defense-in-depth on unmounted path)', async () => {
    const res = await request(app)
      .post('/api/v1/feedback/create')
      .send({ title: 'Test Feedback', detail: 'This is a test feedback.', priority: 'high' });
    expect(res.statusCode).toBe(401);
  });
});
