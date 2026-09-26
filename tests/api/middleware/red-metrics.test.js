// tests/api/middleware/red-metrics.test.js
// responseTime ミドルウェアの RED メトリクス:
//  - http_requests_total / http_request_duration_seconds が /metrics に出る
//  - route ラベルは :id テンプレートに正規化され、実 URL の UUID が流入しない
//    （高カーディナリティによる時系列爆発の防止）
const request = require('supertest');
const { app } = require('../../../src/api/server');

describe('RED metrics (http_requests_total)', () => {
  it('exposes request counters and duration histogram on /metrics', async () => {
    // パラメータ付きルートを1回叩く（未登録 UUID → 404 でもルートはマッチする）
    const fakeId = '123e4567-e89b-42d3-a456-426614174000';
    await request(app).get(`/api/v1/gpus/${fakeId}`);

    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('http_requests_total');
    expect(res.text).toContain('http_request_duration_seconds');
    // ルートテンプレートがラベルに使われること
    expect(res.text).toContain('route="/api/v1/gpus/:id"');
    // 実 URL の UUID が label 値に混入していないこと（カーディナリティ爆発防止）
    expect(res.text).not.toContain(fakeId);
  });
});
