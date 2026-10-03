// tests/api/rate-limit-retry-after.test.js — 429 応答の Retry-After ヘッダー固定。
// RFC 9110 §10.2.3 では 429 への Retry-After 付与が SHOULD。express-rate-limit の
// standardHeaders は RateLimit-* のみを送出するため、カスタム handler で付与する。
// テスト環境では max が 10000 に緩和されるため、リクエスト中だけ NODE_ENV を非 test にして
// env 経由の小さな上限で 429 を発火させる。

const express = require('express');
const request = require('supertest');
const limiter = require('../../src/api/middleware/rate-limit');
const { authLimiter } = require('../../src/api/middleware/rate-limit');

const SAVED_ENV = {};

beforeAll(() => {
  SAVED_ENV.NODE_ENV = process.env.NODE_ENV;
  SAVED_ENV.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX;
  SAVED_ENV.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX;
});

afterEach(() => {
  if (SAVED_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = SAVED_ENV.NODE_ENV;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.AUTH_RATE_LIMIT_MAX;
});

function buildApp(mw) {
  const app = express();
  app.use(mw);
  app.get('/', (req, res) => res.json({ ok: true }));
  return app;
}

describe('rate-limit Retry-After ヘッダー (RFC 9110)', () => {
  test('上限超過の 429 へ Retry-After と RateLimit-* が付く', async () => {
    process.env.NODE_ENV = 'development';
    process.env.RATE_LIMIT_MAX = '1';
    const app = buildApp(limiter);

    expect((await request(app).get('/')).status).toBe(200);
    const res = await request(app).get('/');
    expect(res.status).toBe(429);

    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    expect(res.headers['ratelimit-limit']).toBe('1');
    expect(res.body).toEqual(messageShape());
  });

  test('authLimiter の 429 も Retry-After を返す（ウィンドウ上限 900s）', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_RATE_LIMIT_MAX = '1';
    const app = buildApp(authLimiter);

    expect((await request(app).get('/')).status).toBe(200);
    const res = await request(app).get('/');
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  test('上限内の応答には Retry-After を付けない', async () => {
    process.env.NODE_ENV = 'development';
    process.env.RATE_LIMIT_MAX = '5';
    const app = buildApp(limiter);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['retry-after']).toBeUndefined();
  });
});

function messageShape() {
  return {
    error: {
      type: 'RATE_LIMIT',
      message: 'リクエストが多すぎます。しばらく待って再試行してください。',
      statusCode: 429
    }
  };
}
