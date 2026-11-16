// 提供者エージェント経由の貸し借り一往復（API 全体フロー）
//
// サーバ起動 → 提供者エージェント接続 → GPU 登録 → 注文 → 承認 → 開始 →
// 借り手がゲートウェイ経由で提供者の上流（スタブ）に到達 → 停止 →
// ゲートウェイが閉じて到達不能に戻る、までを実ソケットで固定する。
// エージェントはサーバと同じプロセスで動かすが、接続は実 TCP/WebSocket で
// 別マシン経路と同一のコードを通る。
const http = require('http');
const request = require('supertest');
const { app } = require('../../src/api/server');
const { hub } = require('../../src/services/provider-agent-hub');
const { createProviderAgent } = require('../../agent/provider-agent');

function decodeUserId(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id;
}

async function waitFor(cond, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function gatewayRequest(url, { token, path = '/', method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('provider agent end-to-end lending flow', () => {
  const suffix = `${Date.now()}`;
  let server;
  let serverBaseUrl;
  let provider;
  let renter;
  let upstream;
  let agent;
  let gpuId;

  const auth = (token) => (r) => r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    server = http.createServer(app);
    hub.attachToServer(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    serverBaseUrl = `http://127.0.0.1:${server.address().port}`;

    const password = 'TestPass123!';
    const mkUser = async (name, role) => {
      const email = `${name}${suffix}@example.com`;
      const body = { username: `${name}${suffix}`, email, password };
      if (role) body.role = role;
      await request(app).post('/api/v1/users/register').send(body);
      const login = await request(app).post('/api/v1/users/login').send({ email, password });
      const accessToken = login.body.token;
      return { accessToken, userId: decodeUserId(accessToken) };
    };
    provider = await mkUser('flowprov', 'provider');
    renter = await mkUser('flowrent', null);

    // 提供者の上流（Ollama のスタブ）
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          upstream: 'stub-ollama', echo: req.url, method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

    // 提供者エージェント接続
    const agentToken = provider.accessToken;
    agent = createProviderAgent({
      serverUrl: serverBaseUrl,
      token: agentToken,
      upstreamUrl: `http://127.0.0.1:${upstream.address().port}`,
    });
    await agent.start();
    await waitFor(() => hub.hasProvider(provider.userId));

    // GPU 登録
    const gpuRes = await auth(provider.accessToken)(request(app).post('/api/v1/gpus')).send({
      name: `Flow GPU ${suffix}`,
      vendor: 'NVIDIA',
      model: 'RTX 4090',
      apiType: 'CUDA',
      driverVersion: '550.54',
      os: 'Linux',
      arch: 'x86_64',
      memoryGB: 24,
      clockMHz: 2520,
      powerWatt: 450,
      pricePerHour: 100,
    });
    expect(gpuRes.statusCode).toBe(201);
    gpuId = gpuRes.body.gpu ? gpuRes.body.gpu.id : gpuRes.body.id;
    expect(gpuId).toBeTruthy();
  });

  afterAll(async () => {
    if (agent) agent.stop();
    hub.closeAll();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => server.close(r));
  });

  it('borrower reaches the provider upstream through the gateway, and stop closes it', async () => {
    // 注文 → 承認 → 開始
    const orderRes = await auth(renter.accessToken)(request(app).post('/api/v1/orders'))
      .send({ gpuId, durationMinutes: 60 });
    expect(orderRes.statusCode).toBe(201);
    const orderId = orderRes.body.orderId;

    const acceptRes = await auth(provider.accessToken)(request(app).post(`/api/v1/orders/${orderId}/accept`)).send({});
    expect(acceptRes.statusCode).toBe(200);

    const startRes = await auth(renter.accessToken)(request(app).post(`/api/v1/orders/${orderId}/start`)).send({});
    expect(startRes.statusCode).toBe(200);
    const access = startRes.body.allocationDetails.accessInfo;
    expect(access.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(access.providerAgent).toBe('connected');
    const sessionToken = access.credentials.token;

    // ゲートウェイのヘルス（セッショントークン必須）
    const health = await gatewayRequest(access.endpoint, { token: sessionToken, path: '/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).providerAgent).toBe('connected');

    // トークン無しは 401
    const noToken = await gatewayRequest(access.endpoint, { path: '/api/generate', method: 'POST', body: '{}' });
    expect(noToken.status).toBe(401);

    // 借り手 → ゲートウェイ → エージェント → 提供者の上流、の一往復
    const res = await gatewayRequest(access.endpoint, {
      token: sessionToken, path: '/api/generate', method: 'POST',
      body: '{"model":"llama3","prompt":"hello"}',
    });
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body);
    expect(echoed.upstream).toBe('stub-ollama');
    expect(echoed.echo).toBe('/api/generate');
    expect(echoed.body).toBe('{"model":"llama3","prompt":"hello"}');

    // 停止 → ゲートウェイが閉じて到達不能に戻る
    const stopRes = await auth(renter.accessToken)(request(app).post(`/api/v1/orders/${orderId}/stop`)).send({});
    expect(stopRes.statusCode).toBe(200);
    const err = await gatewayRequest(access.endpoint, { token: sessionToken, path: '/health' })
      .then(() => null, (e) => e);
    expect(err).not.toBeNull();
    expect(['ECONNREFUSED', 'ECONNRESET']).toContain(err.code);
  });
});
