// KPI API テスト（Jest）
// 注: /api/v1/kpi/report エンドポイントは未実装（aspirational）。全 /api/v1/* は
// グローバル JWT ゲートで保護されるため、無認証アクセスは未実装パスでも 401 で遮断される。
// その多層防御の契約を固定する。機能本体実装時に認証済みの正常系を追加すること。
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('KPI API', () => {
  it('rejects unauthenticated requests with 401 (defense-in-depth on unmounted path)', async () => {
    const res = await request(app)
      .post('/api/v1/kpi/report')
      .send({ date: new Date().toISOString(), todo: 5, done: 10, wip: 2 });
    expect(res.statusCode).toBe(401);
  });
});
