// 静的アセットの Cache-Control 方針テスト
// - フィンガープリント付き（version-assets.js 生成の file.<8hex>.<ext>）は immutable 長期
// - HTML は毎回再検証（新規アセット参照を拾うため）
// - その他の静的ファイルは短いキャッシュ
// - API レスポンスは従来どおり no-store（回帰防止）
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../../src/api/server');

const PUBLIC_DIR = path.join(__dirname, '../../public');
// express.static のみで解決されるルート直下のフィンガープリント付きテストフィクスチャ
const FP_NAME = 'cacheprobe.1a2b3c4d.js';
const FP_PATH = path.join(PUBLIC_DIR, FP_NAME);

describe('static asset Cache-Control', () => {
  beforeAll(() => {
    fs.writeFileSync(FP_PATH, 'console.log("probe");\n');
  });
  afterAll(() => {
    try { fs.unlinkSync(FP_PATH); } catch (_) { /* noop */ }
  });

  it('fingerprinted asset gets immutable long-term cache', async () => {
    const res = await request(app).get(`/${FP_NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('html gets must-revalidate', async () => {
    const res = await request(app).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('plain static asset gets short cache', async () => {
    const res = await request(app).get('/js/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('API responses stay no-store (regression guard)', async () => {
    const res = await request(app).get('/api/v1/gpus');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
