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

  // 見積は「根拠があるときだけ提示してよい」。feature-pricer は特徴量が全部欠けていても
  // 数字を返す（未知型番でも VRAM だけで 333 sats/時 のような値が出る）ので、それを
  // そのまま参考価格として人に見せると、知らないのに知っているふりをすることになる。
  describe('a quote says whether it has any basis', () => {
    it('marks a known model as quotable and names the matched reference', async () => {
      const res = await auth(request(app).post('/api/v1/marketplace/quote'))
        .send({ gpu: { vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24 } });
      expect(res.statusCode).toBe(200);
      expect(res.body.basis).toMatchObject({ quotable: true, matchedModel: 'rtx 4090' });
      expect(res.body.pricePerHour).toBeGreaterThan(0);
    });

    it('refuses to vouch for a model that is not in the reference table', async () => {
      const res = await auth(request(app).post('/api/v1/marketplace/quote'))
        .send({ gpu: { vendor: 'NVIDIA', model: 'Totally Made Up 9000', memoryGB: 16 } });
      expect(res.statusCode).toBe(200);
      expect(res.body.basis.quotable).toBe(false);
      expect(res.body.basis.matchedModel).toBeNull();
      expect(res.body.basis.confidence).toBe('unknown');
    });

    it('refuses when the declared VRAM contradicts the named model', async () => {
      // 「H100」を名乗って 8GB と申告するような自己申告。参照表を信用しない。
      const res = await auth(request(app).post('/api/v1/marketplace/quote'))
        .send({ gpu: { vendor: 'NVIDIA', model: 'H100', memoryGB: 8 } });
      expect(res.statusCode).toBe(200);
      expect(res.body.basis.quotable).toBe(false);
      expect(res.body.basis.findings.join(' ')).toMatch(/vram_mismatch/);
    });

    it('prices a stronger card above a weaker one', async () => {
      const strong = await auth(request(app).post('/api/v1/marketplace/quote'))
        .send({ gpu: { vendor: 'NVIDIA', model: 'H100', memoryGB: 80 } });
      const weak = await auth(request(app).post('/api/v1/marketplace/quote'))
        .send({ gpu: { vendor: 'NVIDIA', model: 'RTX 3060', memoryGB: 12 } });
      expect(strong.body.pricePerHour).toBeGreaterThan(weak.body.pricePerHour);
    });
  });

});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
