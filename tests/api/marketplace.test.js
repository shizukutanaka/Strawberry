// tests/api/marketplace.test.js
const request = require('supertest');
const { app } = require('../../src/api/server');

const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

let token;

beforeAll(async () => {
  // Register a real user so the per-request user lookup in jwtAuth succeeds.
  const suffix = `${Date.now()}`;
  const email = `market${suffix}@example.com`;
  const password = 'TestPass123!';
  await request(app).post('/api/v1/users/register').send({
    username: `mkttester${suffix}`,
    email,
    password,
  });
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  token = login.body.token;
});

const auth = (r) => r.set('Authorization', `Bearer ${token}`);

describe('marketplace API', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/marketplace/quote').send({ gpu: GPU });
    expect(res.statusCode).toBe(401);
  });

  it('POST /quote returns a feature-based price for a valid GPU', async () => {
    const res = await auth(request(app).post('/api/v1/marketplace/quote')).send({ gpu: GPU, market: { utilization: 0.5 } });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.pricePerHour).toBe('number');
    expect(res.body.pricePerHour).toBeGreaterThan(0);
    expect(res.body.breakdown).toBeDefined();
  });

  it('POST /quote validates input (400 on missing gpu)', async () => {
    const res = await auth(request(app).post('/api/v1/marketplace/quote')).send({ market: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /rank returns a ranked list and validates input', async () => {
    const ok = await auth(request(app).post('/api/v1/marketplace/rank')).send({ providerIds: ['a', 'b'] });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.body.ranked)).toBe(true);

    const bad = await auth(request(app).post('/api/v1/marketplace/rank')).send({ providerIds: 'nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('POST /auction ignores client-forged authoritative fields (reputationScore/eligible/attestation)', async () => {
    // 悪意ある入札: 自陣プロバイダに満点レピュテーション・アテステーション合格を主張し、
    // 競合を eligible:false で排除しようとする。ルートはこれらを破棄し、
    // 権威側（reputationService 等）の値のみで採点しなければならない。
    const res = await auth(request(app).post('/api/v1/marketplace/auction')).send({
      bids: [
        { providerId: 'honest-a', pricePerHour: 100 },
        { providerId: 'honest-b', pricePerHour: 100, eligible: false },
        {
          providerId: 'evil',
          pricePerHour: 100,
          reputationScore: 1,
          attestationScore: 1,
          attestationPassed: true,
          slaUptimePct: 100,
          eligible: true,
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const evil = res.body.ranked.find(r => r.providerId === 'evil');
    expect(evil).toBeDefined();
    // 権威値で上書きされていること: 未知プロバイダはベイズ既定スコア（1ではない）
    expect(evil.components.reputation).not.toBe(1);
    // attestation は未記録プロバイダでは 0（クライアント偽装の 1 ではない）
    expect(evil.components.attestation).toBe(0);
    // クライアントが eligible:false を付けた競合は排除されず ranked に残る
    const honestB = res.body.ranked.find(r => r.providerId === 'honest-b');
    expect(honestB).toBeDefined();
    expect(res.body.rejected.find(r => r.providerId === 'honest-b')).toBeUndefined();
    // 同価格・同権威値ならスコアは全員同じ（偽装が効いていない証拠）
    const scores = res.body.ranked.map(r => r.score);
    expect(new Set(scores.map(s => s.toFixed(10))).size).toBe(1);
  });

  it('POST /auction tolerates non-object bids without crashing', async () => {
    const res = await auth(request(app).post('/api/v1/marketplace/auction')).send({
      bids: [null, 'x', { providerId: 'ok', pricePerHour: 50 }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.ranked.find(r => r.providerId === 'ok')).toBeDefined();
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
