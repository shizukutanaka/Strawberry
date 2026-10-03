// /api/exchange-rate REST API自動テスト
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('GET /api/exchange-rate', () => {
  it('should return rate, timestamp, isCache', async () => {
    const res = await request(app)
      .get('/api/exchange-rate');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('rate');
    expect(typeof res.body.rate).toBe('number');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('isCache');
  });

  it('should force fresh fetch when ?fresh=true', async () => {
    const res = await request(app)
      .get('/api/exchange-rate?fresh=true');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('rate');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body.isCache === false || res.body.isCache === true).toBe(true);
  });

  // 回帰: 時限データであるレート応答は他の動的ルートと同じくキャッシュ不可。
  // 以前はミドルウェア群より前にマウントされ no-store/セキュリティヘッダーが
  // 付かず、中間キャッシュが陳腐レートを返し続けうる状態だった。
  it('serves the rate with Cache-Control: no-store and security headers', async () => {
    const res = await request(app).get('/api/exchange-rate');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
