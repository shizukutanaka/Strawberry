// 提供者エージェントのテスト
//
// 別マシンの提供者 GPU へ届かせる経路を実ソケットで固定する:
//   - ハブの接続認証は既存 JWT 基盤と同一（無トークン/不正トークンは 401）
//   - ゲートウェイは GPU の providerId 本人のエージェントへだけ中継する
//   - エージェントは指定した上流 origin へしか中継しない（SSRF 防止）
//   - エージェント未接続・切断時は正直な 502 を返す
const http = require('http');
const request = require('supertest');
const { app } = require('../../src/api/server');
const { VirtualGPUManager } = require('../../virtual-gpu-manager');
const { hub } = require('../../src/services/provider-agent-hub');
const { connectClient } = require('../../src/services/ws-rfc6455');
const { createProviderAgent, handleRequestMessage } = require('../../agent/provider-agent');

function decodeUserId(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id;
}

async function registerAndLogin(suffix, role) {
  const email = `agent${suffix}@example.com`;
  const password = 'TestPass123!';
  const body = { username: `agent${suffix}`, email, password };
  if (role) body.role = role;
  await request(app).post('/api/v1/users/register').send(body);
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  const accessToken = login.body.token;
  return { accessToken, userId: decodeUserId(accessToken) };
}

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function startEchoUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        echo: req.url, method: req.method, bodyLength: body.length, body: body.toString('utf8'),
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
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

function makeManager() {
  const mgr = Object.create(VirtualGPUManager.prototype);
  mgr.platform = 'native';
  mgr.virtualGPUs = new Map();
  mgr.allocations = new Map();
  mgr.emit = () => {};
  return mgr;
}

describe('provider agent hub + gateway routing', () => {
  let hubServer;
  let hubBaseUrl;
  let providerA;
  let providerB;
  const suffix = `${Date.now()}`;

  beforeAll(async () => {
    providerA = await registerAndLogin(`a${suffix}`, 'provider');
    providerB = await registerAndLogin(`b${suffix}`, 'provider');
    hubServer = http.createServer();
    hub.attachToServer(hubServer);
    await new Promise((r) => hubServer.listen(0, '127.0.0.1', r));
    hubBaseUrl = `http://127.0.0.1:${hubServer.address().port}`;
  });

  afterAll(async () => {
    hub.closeAll();
    await new Promise((r) => hubServer.close(r));
  });

  it('rejects the agent connection without a token (401)', async () => {
    await expect(connectClient(`ws://127.0.0.1:${hubServer.address().port}/api/v1/agent/connect`))
      .rejects.toThrow(/401/);
  });

  it('rejects the agent connection with an invalid token (401)', async () => {
    await expect(connectClient(
      `ws://127.0.0.1:${hubServer.address().port}/api/v1/agent/connect`,
      { headers: { Authorization: 'Bearer not-a-real-token' } }
    )).rejects.toThrow(/401/);
  });

  it('accepts a valid provider token and unregisters on close', async () => {
    const ws = await connectClient(
      `ws://127.0.0.1:${hubServer.address().port}/api/v1/agent/connect`,
      { headers: { Authorization: `Bearer ${providerA.accessToken}` } }
    );
    await waitFor(() => hub.hasProvider(providerA.userId));
    expect(hub.hasProvider(providerA.userId)).toBe(true);
    ws.close();
    await waitFor(() => !hub.hasProvider(providerA.userId));
  });

  describe('with a running provider agent', () => {
    let upstream;
    let agent;

    beforeAll(async () => {
      upstream = await startEchoUpstream();
      const agentToken = providerA.accessToken;
      agent = createProviderAgent({
        serverUrl: hubBaseUrl,
        token: agentToken,
        upstreamUrl: upstream.url,
      });
      await agent.start();
      await waitFor(() => hub.hasProvider(providerA.userId));
    });

    afterAll(async () => {
      agent.stop();
      await waitFor(() => !hub.hasProvider(providerA.userId)).catch(() => {});
      await upstream.close();
    });

    it('gateway forwards borrower requests through the agent to the provider upstream', async () => {
      const mgr = makeManager();
      const alloc = await mgr.allocateGPU('gpu-agent-1', 'rental-a1',
        { name: 'Agent GPU', memoryGB: 24, providerId: providerA.userId });
      expect(alloc.success).toBe(true);
      expect(alloc.accessInfo.providerAgent).toBe('connected');

      const health = await gatewayRequest(alloc.accessInfo.endpoint, {
        token: alloc.accessInfo.credentials.token, path: '/health',
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body).providerAgent).toBe('connected');

      const res = await gatewayRequest(alloc.accessInfo.endpoint, {
        token: alloc.accessInfo.credentials.token,
        path: '/v1/chat/completions', method: 'POST', body: '{"prompt":"hi"}',
      });
      expect(res.status).toBe(200);
      const echoed = JSON.parse(res.body);
      expect(echoed.echo).toBe('/v1/chat/completions');
      expect(echoed.method).toBe('POST');
      expect(echoed.body).toBe('{"prompt":"hi"}');

      // セッショントークンが無いリクエストはゲートウェイで 401（エージェントへ届かない）
      const noToken = await gatewayRequest(alloc.accessInfo.endpoint, { path: '/v1/models' });
      expect(noToken.status).toBe(401);

      await mgr.releaseGPU('gpu-agent-1', 'rental-a1');
    });

    it('gateway round-trips a large body (200KB) through the tunnel', async () => {
      const mgr = makeManager();
      const alloc = await mgr.allocateGPU('gpu-agent-2', 'rental-a2',
        { name: 'Agent GPU', memoryGB: 24, providerId: providerA.userId });
      const big = 'x'.repeat(200 * 1024);
      const res = await gatewayRequest(alloc.accessInfo.endpoint, {
        token: alloc.accessInfo.credentials.token,
        path: '/v1/embeddings', method: 'POST', body: big,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).bodyLength).toBe(200 * 1024);
      await mgr.releaseGPU('gpu-agent-2', 'rental-a2');
    });

    it('gateway refuses absolute-form targets on the agent route (SSRF guard)', async () => {
      const mgr = makeManager();
      const alloc = await mgr.allocateGPU('gpu-agent-3', 'rental-a3',
        { name: 'Agent GPU', memoryGB: 24, providerId: providerA.userId });
      const u = new URL(alloc.accessInfo.endpoint);
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: u.hostname, port: u.port, path: 'http://169.254.169.254/latest/meta-data', method: 'GET',
          headers: { Authorization: `Bearer ${alloc.accessInfo.credentials.token}` },
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(400);
      await mgr.releaseGPU('gpu-agent-3', 'rental-a3');
    });

    it('never routes to another provider\'s agent', async () => {
      const mgr = makeManager();
      const alloc = await mgr.allocateGPU('gpu-agent-4', 'rental-a4',
        { name: 'Other GPU', memoryGB: 24, providerId: providerB.userId });
      expect(alloc.accessInfo.providerAgent).toBe('not-connected');
      const res = await gatewayRequest(alloc.accessInfo.endpoint, {
        token: alloc.accessInfo.credentials.token,
        path: '/v1/models', method: 'GET',
      });
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body).error).toMatch(/Provider agent is not connected/);
      await mgr.releaseGPU('gpu-agent-4', 'rental-a4');
    });
  });

  it('after the agent disconnects, the gateway returns an honest 502', async () => {
    const upstream = await startEchoUpstream();
    const agentToken = providerB.accessToken;
    const agent = createProviderAgent({
      serverUrl: hubBaseUrl,
      token: agentToken,
      upstreamUrl: upstream.url,
    });
    await agent.start();
    await waitFor(() => hub.hasProvider(providerB.userId));
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-agent-5', 'rental-a5',
      { name: 'Agent GPU B', memoryGB: 24, providerId: providerB.userId });
    const ok = await gatewayRequest(alloc.accessInfo.endpoint, {
      token: alloc.accessInfo.credentials.token, path: '/v1/models',
    });
    expect(ok.status).toBe(200);
    agent.stop();
    await waitFor(() => !hub.hasProvider(providerB.userId));
    const res = await gatewayRequest(alloc.accessInfo.endpoint, {
      token: alloc.accessInfo.credentials.token, path: '/v1/models',
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/Provider agent is not connected/);
    await mgr.releaseGPU('gpu-agent-5', 'rental-a5');
    await upstream.close();
  });
});

describe('provider agent request handler (SSRF discipline)', () => {
  it('refuses protocol-relative and absolute paths instead of relaying', async () => {
    const upstream = await startEchoUpstream();
    try {
      const protoRelative = await handleRequestMessage(
        { id: '1', method: 'GET', path: '//169.254.169.254/latest/meta-data', headers: {}, bodyBase64: '' },
        upstream.url
      );
      expect(protoRelative.status).toBe(400);
      const absolute = await handleRequestMessage(
        { id: '2', method: 'GET', path: 'http://169.254.169.254/latest/meta-data', headers: {}, bodyBase64: '' },
        upstream.url
      );
      expect(absolute.status).toBe(400);
    } finally {
      await upstream.close();
    }
  });

  it('forwards to the configured upstream and returns its response', async () => {
    const upstream = await startEchoUpstream();
    try {
      const res = await handleRequestMessage(
        {
          id: '3', method: 'POST', path: '/api/generate?stream=false',
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.from('{"model":"llama"}').toString('base64'),
        },
        upstream.url
      );
      expect(res.status).toBe(200);
      const echoed = JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf8'));
      expect(echoed.echo).toBe('/api/generate?stream=false');
      expect(echoed.body).toBe('{"model":"llama"}');
    } finally {
      await upstream.close();
    }
  });

  it('reports an unreachable upstream as 502 instead of throwing', async () => {
    const res = await handleRequestMessage(
      { id: '4', method: 'GET', path: '/api/tags', headers: {}, bodyBase64: '' },
      'http://127.0.0.1:1'
    );
    expect(res.status).toBe(502);
    expect(JSON.parse(Buffer.from(res.bodyBase64, 'base64').toString('utf8')).error)
      .toMatch(/unreachable/);
  });
});
