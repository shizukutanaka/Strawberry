// SPA フォールバック（app.get('*')）の契約テスト
// - SPA ルート（拡張子なし・API 系でないパス）は index.html を返す（既存挙動）
// - API 系パスの未知パスは HTML ではなく JSON 404/401 を返す（API クライアントの契約）
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('SPA fallback', () => {
  it('serves index.html for client-side routes without extension', async () => {
    const res = await request(app).get('/dashboard/orders');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('does not serve index.html for asset-like paths (dot in path)', async () => {
    const res = await request(app).get('/js/nonexistent-file.js');
    expect(res.status).toBe(404);
  });

  it('unknown API paths return JSON, not index.html', async () => {
    // 未認証なら jwtAuth が 401、認証済みでもワイルドカードが API パスを
    // スキップして notFoundMiddleware の JSON 404 に落ちる。いずれにせよ
    // text/html の 200 にならないことが契約。
    const res = await request(app).get('/api/v1/definitely-not-a-route');
    expect(res.status).not.toBe(200);
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('unknown master-auth and secondary API prefixes do not get HTML fallback', async () => {
    for (const p of ['/master-auth/nope', '/api/profit-addresses/nope']) {
      const res = await request(app).get(p);
      expect(res.headers['content-type'] || '').not.toMatch(/text\/html/);
    }
  });
});
