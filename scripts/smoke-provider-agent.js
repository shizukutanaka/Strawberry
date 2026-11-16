// scripts/smoke-provider-agent.js — 提供者エージェント経路の実走スモーク
//
// 実サーバ（子プロセス）と実エージェント（子プロセス）を起動し、
//   サーバ起動 → エージェント接続 → GPU登録 → 注文 → 承認 → 開始 →
//   借り手がゲートウェイ経由で提供者の上流（スタブ）に到達 → 停止 →
//   到達不能に戻る
// までの一往復を検証する。データは一時ディレクトリに隔離し、終了時に消す。
//
// 実行: node scripts/smoke-provider-agent.js（終了コード 0 = 全ステップ成功）
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function step(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status) return;
    } catch (_) { /* 起動待ち */ }
    if (Date.now() - start > timeoutMs) throw new Error(`server did not come up: ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function api(base, method, p, accessToken, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${base}${p}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* noop */ }
  return { status: res.status, json, text };
}

function gatewayFetch(endpoint, sessionToken, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, endpoint);
    const headers = {};
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (body) headers['Content-Type'] = 'application/json';
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strawberry-smoke-'));
  const port = await freePort();
  // サーバは config の host（既定 localhost）にバインドする。localhost の解決先
  // （IPv4/IPv6）を揃えるため、接続側も localhost を使う。
  const base = `http://localhost:${port}`;
  const jwtSecret = `smoke-${crypto.randomBytes(24).toString('hex')}`;
  const suffix = `${Date.now()}`;
  const password = 'SmokePass123!';
  const children = [];

  // 提供者の上流スタブ（Ollama の代わり）
  const upstream = http.createServer((req, res) => {
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
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  try {
    // 1. サーバ起動
    const serverProc = spawn(process.execPath, [path.join(ROOT, 'src/api/server.js')], {
      env: {
        ...process.env, PORT: String(port), STRAWBERRY_DATA_DIR: dataDir,
        JWT_SECRET: jwtSecret, NODE_ENV: 'development',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(serverProc);
    await waitForHttp(`${base}/api/v1/system/info`);
    step('server started', true, base);

    // 2. ユーザー登録（提供者・借り手）とログイン
    const mkUser = async (name, role) => {
      const email = `${name}${suffix}@example.com`;
      const regBody = { username: `${name}${suffix}`, email, password };
      if (role) regBody.role = role;
      await api(base, 'POST', '/api/v1/users/register', null, regBody);
      const login = await api(base, 'POST', '/api/v1/users/login', null, { email, password });
      return login.json.accessToken || login.json.token;
    };
    const providerAccess = await mkUser('smokeprov', 'provider');
    const renterAccess = await mkUser('smokerent', null);
    step('provider and renter registered/logged in', !!(providerAccess && renterAccess));

    // 3. 提供者エージェント接続（子プロセス）
    const agentProc = spawn(process.execPath, [path.join(ROOT, 'agent/provider-agent.js')], {
      env: {
        ...process.env,
        STRAWBERRY_SERVER_URL: base,
        STRAWBERRY_AGENT_TOKEN: providerAccess,
        STRAWBERRY_UPSTREAM_URL: upstreamUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(agentProc);
    let agentLog = '';
    agentProc.stdout.on('data', (d) => { agentLog += d; });
    agentProc.stderr.on('data', (d) => { agentLog += d; });
    const agentDeadline = Date.now() + 15000;
    while (!agentLog.includes('connected to Strawberry server')) {
      if (Date.now() > agentDeadline) throw new Error(`agent did not connect. log: ${agentLog}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    step('provider agent connected', true);

    // 4. GPU 登録
    const gpuRes = await api(base, 'POST', '/api/v1/gpus', providerAccess, {
      name: `Smoke GPU ${suffix}`, vendor: 'NVIDIA', model: 'RTX 4090', apiType: 'CUDA',
      driverVersion: '550.54', os: 'Linux', arch: 'x86_64', memoryGB: 24,
      clockMHz: 2520, powerWatt: 450, pricePerHour: 100,
    });
    const gpuId = gpuRes.json && gpuRes.json.gpu && gpuRes.json.gpu.id;
    step('GPU registered', gpuRes.status === 201 && !!gpuId, `status=${gpuRes.status}`);

    // 5. 注文 → 承認 → 開始
    const orderRes = await api(base, 'POST', '/api/v1/orders', renterAccess, { gpuId, durationMinutes: 60 });
    const orderId = orderRes.json && orderRes.json.orderId;
    step('order created', orderRes.status === 201 && !!orderId, `status=${orderRes.status}`);
    const acceptRes = await api(base, 'POST', `/api/v1/orders/${orderId}/accept`, providerAccess, {});
    step('order accepted', acceptRes.status === 200, `status=${acceptRes.status}`);
    const startRes = await api(base, 'POST', `/api/v1/orders/${orderId}/start`, renterAccess, {});
    const accessInfo = startRes.json && startRes.json.allocationDetails
      && startRes.json.allocationDetails.accessInfo;
    step('order started', startRes.status === 200 && !!accessInfo, `status=${startRes.status}`);
    step('accessInfo reports providerAgent=connected', !!accessInfo && accessInfo.providerAgent === 'connected',
      accessInfo ? `providerAgent=${accessInfo.providerAgent}` : 'no accessInfo');
    const sessionToken = accessInfo.credentials.token;
    const endpoint = accessInfo.endpoint;

    // 6. ゲートウェイ経由で提供者の上流へ到達
    const health = await gatewayFetch(endpoint, sessionToken, '/health');
    step('gateway health via agent route', health.status === 200
      && JSON.parse(health.text).providerAgent === 'connected', `status=${health.status}`);
    const noToken = await gatewayFetch(endpoint, null, '/api/generate', { method: 'POST', body: '{}' });
    step('gateway rejects tokenless request (401)', noToken.status === 401, `status=${noToken.status}`);
    const gen = await gatewayFetch(endpoint, sessionToken, '/api/generate', {
      method: 'POST', body: '{"model":"llama3","prompt":"hello"}',
    });
    let genOk = false;
    try {
      const echoed = JSON.parse(gen.text);
      genOk = gen.status === 200 && echoed.upstream === 'stub-ollama'
        && echoed.echo === '/api/generate' && echoed.body === '{"model":"llama3","prompt":"hello"}';
    } catch (_) { /* noop */ }
    step('borrower reached provider upstream through gateway+agent', genOk, `status=${gen.status}`);

    // 7. 停止 → 到達不能に戻る
    const stopRes = await api(base, 'POST', `/api/v1/orders/${orderId}/stop`, renterAccess, {});
    step('order stopped', stopRes.status === 200, `status=${stopRes.status}`);
    const after = await gatewayFetch(endpoint, sessionToken, '/health').then(() => null, (e) => e);
    step('gateway unreachable after stop', !!after && ['ECONNREFUSED', 'ECONNRESET'].includes(after.code),
      after ? `code=${after.code}` : 'still reachable');
  } finally {
    for (const child of children) { try { child.kill('SIGTERM'); } catch (_) { /* noop */ } }
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nSMOKE OK: provider-agent path works end to end' : `\nSMOKE FAILED: ${failures} step(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`SMOKE ERROR: ${e.message}`);
  process.exit(1);
});
