// Notification API テスト（Jest）
// 注: /api/v1/notification/create エンドポイントは未実装（aspirational）。設定系は
// src/api/notification-settings.js に存在するが create ルートは未配線。全 /api/v1/* は
// グローバル JWT ゲートで保護されるため、無認証アクセスは未実装パスでも 401 で遮断される。
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('Notification API', () => {
  it('rejects unauthenticated requests with 401 (defense-in-depth on unmounted path)', async () => {
    const res = await request(app)
      .post('/api/v1/notification/create')
      .send({ userId: 1, message: '通知テスト', type: 'info' });
    expect(res.statusCode).toBe(401);
  });
});
