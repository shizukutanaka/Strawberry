// API基本動作テスト（Jest + supertest）
// サーバが起動でき(=全モジュールがクラッシュせず読み込める)、
// メトリクスが公開され、保護されたAPIが未認証で401を返すことを確認するスモークテスト。
const request = require('supertest');
const { app } = require('../../src/api/server');

describe('API基本テスト', () => {
  it('GET /metrics で Prometheus メトリクスを 200 で返す', async () => {
    const res = await request(app).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('# HELP');
  });

  it('GET /.well-known/security.txt で RFC 9116 の連絡先を text/plain で返す', async () => {
    // .well-known はドット始まりセグメントのため express.static の既定では届かない
    // （SPA キャッチオールが index.html を返す）。明示ルートの回帰テスト。
    const res = await request(app).get('/.well-known/security.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('Contact:');
    expect(res.text).toContain('Expires:');
  });

  it('保護された API は未認証だと 401 を返す', async () => {
    // /gpus は公開（マーケットプレイスブラウジング用）。/orders は認証必須。
    const res = await request(app).post('/api/v1/orders').send({});
    expect(res.statusCode).toBe(401);
  });
});

// supertest がポートを開いた server を掴んだままにしないよう明示的に閉じる
afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) {
    server.close(() => done());
  } else {
    done();
  }
});
