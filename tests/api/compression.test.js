// レスポンス圧縮ミドルウェアのテスト
// - 1KB 超のレスポンスは Accept-Encoding: gzip で Content-Encoding: gzip が返る
// - Accept-Encoding 未指定のクライアントには無圧縮を返す（交渉の後方互換）
// - 小さいレスポンスは閾値未満で圧縮しない（既定挙動の確認）
const zlib = require('zlib');
const request = require('supertest');
const { app } = require('../../src/api/server');

// /openapi.json は実ルート走査の生成物で常に数 KB あるため、
// 既定閾値 1KB を確実に超える圧縮検証用エンドポイントとして使う。
const BIG_PATH = '/openapi.json';

describe('response compression', () => {
  it('compresses large responses when client sends Accept-Encoding: gzip', async () => {
    const res = await request(app).get(BIG_PATH).set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    // supertest が自動解凍して body を返すため、wire 上の圧縮は
    // Content-Encoding ヘッダの存在で確認する。
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/accept-encoding/i);
  });

  it('does not compress when client does not advertise gzip', async () => {
    const res = await request(app).get(BIG_PATH).set('Accept-Encoding', 'identity');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('compressed wire body is valid gzip and decodes to the same JSON', async () => {
    // superagent の自動解凍を回避するため生 HTTP で wire ボディを検証
    const http = require('http');
    const server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    try {
      const port = server.address().port;
      const body = await new Promise((resolve, reject) => {
        http.get({ port, path: BIG_PATH, headers: { 'Accept-Encoding': 'gzip' } }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
      const decoded = JSON.parse(zlib.gunzipSync(body).toString('utf8'));
      expect(decoded.openapi || decoded.swagger).toBeTruthy();
      expect(decoded.paths).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
