// VirtualGPUManager native セッション受け渡しのテスト
//
// 背景: native 割り当ては長らく endpoint:null / deliveryImplemented:false を返し、
// 借り手は「割り当てられたが接続先が無い」状態だった。setupNativeAccess が
// 割り当てごとに実在する HTTP ゲートウェイ（トークン認証つき）を立て、
// releaseNativeAccess がそれを閉じることを、実ソケットで固定する。
const http = require('http');
const { VirtualGPUManager } = require('../../virtual-gpu-manager');

function makeManager() {
  const mgr = Object.create(VirtualGPUManager.prototype);
  mgr.platform = 'native';
  mgr.virtualGPUs = new Map();
  mgr.allocations = new Map();
  mgr.emit = () => {};
  return mgr;
}

function request(url, { token, path = '/', method = 'GET', body } = {}) {
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

const GPU_RECORD = { name: 'Session Test GPU', memoryGB: 24 };

describe('VirtualGPUManager native session handover', () => {
  const savedUpstream = process.env.STRAWBERRY_NATIVE_UPSTREAM_URL;
  afterEach(() => {
    if (savedUpstream === undefined) delete process.env.STRAWBERRY_NATIVE_UPSTREAM_URL;
    else process.env.STRAWBERRY_NATIVE_UPSTREAM_URL = savedUpstream;
  });

  it('allocateGPU hands over a real endpoint with deliveryImplemented=true', async () => {
    delete process.env.STRAWBERRY_NATIVE_UPSTREAM_URL;
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-1', 'rental-1', GPU_RECORD);
    expect(alloc.success).toBe(true);
    expect(alloc.accessInfo.type).toBe('native');
    expect(alloc.accessInfo.deliveryImplemented).toBe(true);
    expect(alloc.accessInfo.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(typeof alloc.accessInfo.credentials.token).toBe('string');
    expect(alloc.accessInfo.credentials.token.length).toBeGreaterThan(20);
    await mgr.releaseGPU('gpu-session-1', 'rental-1');
  });

  it('gateway rejects requests without a valid token (401)', async () => {
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-2', 'rental-2', GPU_RECORD);
    const noToken = await request(alloc.accessInfo.endpoint, {});
    expect(noToken.status).toBe(401);
    const wrongToken = await request(alloc.accessInfo.endpoint, { token: 'wrong-token-value' });
    expect(wrongToken.status).toBe(401);
    await mgr.releaseGPU('gpu-session-2', 'rental-2');
  });

  it('gateway answers session health with the token', async () => {
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-3', 'rental-3', GPU_RECORD);
    const res = await request(alloc.accessInfo.endpoint, { token: alloc.accessInfo.credentials.token, path: '/health' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('active');
    expect(body.allocationId).toBe(alloc.allocationId);
    expect(body.upstream).toBe('not-configured');
    await mgr.releaseGPU('gpu-session-3', 'rental-3');
  });

  it('without an upstream, compute paths return an honest 502', async () => {
    delete process.env.STRAWBERRY_NATIVE_UPSTREAM_URL;
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-4', 'rental-4', GPU_RECORD);
    const res = await request(alloc.accessInfo.endpoint, {
      token: alloc.accessInfo.credentials.token, path: '/v1/chat/completions', method: 'POST', body: '{}',
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/No GPU service is configured/);
    await mgr.releaseGPU('gpu-session-4', 'rental-4');
  });

  it('forwards requests to the configured local GPU service', async () => {
    const upstream = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: req.url, method: req.method, body: data }));
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    process.env.STRAWBERRY_NATIVE_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}`;
    try {
      const mgr = makeManager();
      const alloc = await mgr.allocateGPU('gpu-session-5', 'rental-5', GPU_RECORD);
      expect(alloc.accessInfo.upstream).toBe('configured');
      const res = await request(alloc.accessInfo.endpoint, {
        token: alloc.accessInfo.credentials.token, path: '/v1/models?x=1', method: 'POST', body: '{"a":1}',
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.echo).toBe('/v1/models?x=1');
      expect(body.method).toBe('POST');
      expect(body.body).toBe('{"a":1}');
      await mgr.releaseGPU('gpu-session-5', 'rental-5');
    } finally {
      await new Promise((r) => upstream.close(r));
    }
  });

  it('gateway refuses absolute-form request targets (SSRF guard)', async () => {
    process.env.STRAWBERRY_NATIVE_UPSTREAM_URL = 'http://127.0.0.1:9';
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-7', 'rental-8', GPU_RECORD);
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
    await mgr.releaseGPU('gpu-session-7', 'rental-8');
  });

  it('releaseGPU closes the gateway (endpoint refuses connections)', async () => {
    const mgr = makeManager();
    const alloc = await mgr.allocateGPU('gpu-session-6', 'rental-6', GPU_RECORD);
    const endpoint = alloc.accessInfo.endpoint;
    const ok = await request(endpoint, { token: alloc.accessInfo.credentials.token });
    expect(ok.status).toBe(200);
    await mgr.releaseGPU('gpu-session-6', 'rental-6');
    await expect(request(endpoint, { token: alloc.accessInfo.credentials.token }))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // 解放後は同じ GPU を再び割り当てられる
    const again = await mgr.allocateGPU('gpu-session-6', 'rental-7', GPU_RECORD);
    expect(again.success).toBe(true);
    await mgr.releaseGPU('gpu-session-6', 'rental-7');
  });
});
