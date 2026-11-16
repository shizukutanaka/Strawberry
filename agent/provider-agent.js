#!/usr/bin/env node
// agent/provider-agent.js — Strawberry 提供者エージェント
//
// GPU 提供者のマシンで動く小さなプログラム。Strawberry サーバへ外向きに
// WebSocket 接続を張り（NAT の内側からでも届く）、セッションゲートウェイから
// 届いたリクエストを、提供者が指定したローカルの GPU サービス（Ollama 等）へ
// 中継する。借り手 → ゲートウェイ → このエージェント → 上流、で一往復する。
//
// セキュリティ:
//   - 中継先は起動時に指定した STRAWBERRY_UPSTREAM_URL の origin のみ。
//     リクエストパスが絶対形式や別 origin を指したら中継せず 400 を返す（SSRF 防止）。
//   - サーバ接続は提供者本人のアクセストークン（JWT）で認証する。
//   - 借り手のセッショントークンはサーバ側ゲートウェイが検証済みで、
//     トークンの無いリクエストはここへ届かない。
//
// 使い方:
//   STRAWBERRY_SERVER_URL=http://localhost:3000 \
//   STRAWBERRY_AGENT_TOKEN=<プロバイダのアクセストークン> \
//   STRAWBERRY_UPSTREAM_URL=http://127.0.0.1:11434 \
//   node agent/provider-agent.js
//
// 依存は Node 標準のみ（WebSocket は src/services/ws-rfc6455.js を共有）。
const http = require('http');
const https = require('https');
const { connectClient } = require('../src/services/ws-rfc6455');

const MAX_BODY_BYTES = 15 * 1024 * 1024; // ゲートウェイ側の収集上限と揃える

function log(...args) {
  console.log(`[provider-agent ${new Date().toISOString()}]`, ...args);
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'upgrade', 'host', 'content-length',
]);

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// トンネルリクエスト1件を上流へ中継し、応答メッセージを返す。
// 中継先は upstreamUrl の origin に固定され、パスは origin-form のみ許可する。
async function handleRequestMessage(msg, upstreamUrl) {
  const base = new URL(upstreamUrl);
  const respond = (status, headers, bodyBuf) => ({
    type: 'response',
    id: msg.id,
    status,
    headers,
    bodyBase64: bodyBuf && bodyBuf.length ? bodyBuf.toString('base64') : '',
  });
  const jsonError = (status, error) => respond(
    status,
    { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify({ error }), 'utf8')
  );

  const rawPath = String(msg.path || '');
  // origin-form（/ 始まり）以外は受け付けない。'//host/...' は new URL が
  // base を無視して別ホストへ向くため明示的に弾く（SSRF 防止）。
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
    return jsonError(400, 'Only origin-form request paths are accepted');
  }
  let target;
  try {
    target = new URL(rawPath, base);
    if (target.origin !== base.origin) throw new Error('origin mismatch');
  } catch (_) {
    return jsonError(400, 'Invalid request path');
  }

  const body = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : Buffer.alloc(0);
  const headers = filterHeaders(msg.headers);
  headers['host'] = target.host;
  if (body.length) headers['content-length'] = body.length;

  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const upstreamReq = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: msg.method || 'GET',
      headers,
    }, (upstreamRes) => {
      const chunks = [];
      let total = 0;
      upstreamRes.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          upstreamRes.destroy();
          resolve(jsonError(502, 'Upstream response too large'));
          return;
        }
        chunks.push(c);
      });
      upstreamRes.on('end', () => {
        resolve(respond(
          upstreamRes.statusCode || 502,
          filterHeaders(upstreamRes.headers),
          Buffer.concat(chunks)
        ));
      });
      upstreamRes.on('error', () => resolve(jsonError(502, 'Upstream response failed')));
    });
    upstreamReq.on('error', (e) => {
      resolve(jsonError(502, `Upstream GPU service is unreachable: ${e.message}`));
    });
    if (body.length) upstreamReq.write(body);
    upstreamReq.end();
  });
}

function toWebSocketUrl(serverUrl) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/$/, '')}/api/v1/agent/connect`;
  u.search = '';
  return u.toString();
}

// エージェント本体。start() で接続し、切断時は指数バックオフで再接続する。
// 再接続の間に開始されたセッションのリクエストはサーバ側で 502 になる
// （セッション自体は維持され、再接続後に同じゲートウェイへ再び届く）。
function createProviderAgent({ serverUrl, token, upstreamUrl, name } = {}) {
  if (!serverUrl) throw new Error('STRAWBERRY_SERVER_URL is required');
  if (!token) throw new Error('STRAWBERRY_AGENT_TOKEN is required');
  if (!upstreamUrl) throw new Error('STRAWBERRY_UPSTREAM_URL is required');
  const upstream = new URL(upstreamUrl); // 形式不正はここで落とす
  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new Error('STRAWBERRY_UPSTREAM_URL must be http(s)');
  }
  const wsUrl = toWebSocketUrl(serverUrl);

  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let backoffMs = 1000;

  async function connectOnce() {
    log(`connecting to ${wsUrl} (upstream: ${upstream.origin})`);
    ws = await connectClient(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    backoffMs = 1000;
    log('connected to Strawberry server');
    ws.sendText(JSON.stringify({
      type: 'hello',
      agent: name || 'strawberry-provider-agent',
      version: 1,
    }));
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.type !== 'request' || !msg.id) return;
      const response = await handleRequestMessage(msg, upstreamUrl);
      try { ws.sendText(JSON.stringify(response)); } catch (_) { /* 切断時はサーバ側がタイムアウト/切断で処理 */ }
    });
    ws.on('close', (code, reason) => {
      ws = null;
      if (stopped) return;
      log(`disconnected (${code} ${reason || ''}); reconnecting in ${backoffMs}ms`);
      reconnectTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, 30000);
        connectOnce().catch((e) => {
          log(`connect failed: ${e.message}`);
          if (!stopped) {
            reconnectTimer = setTimeout(() => connectOnce().catch(() => {}), backoffMs);
          }
        });
      }, backoffMs);
      if (reconnectTimer.unref) reconnectTimer.unref();
    });
    ws.on('error', (e) => log(`socket error: ${e.message}`));
  }

  return {
    async start() {
      stopped = false;
      await connectOnce();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(1000, 'agent shutting down'); } catch (_) { /* noop */ } }
    },
    isConnected() { return !!ws; },
  };
}

if (require.main === module) {
  let agent;
  try {
    const agentToken = process.env.STRAWBERRY_AGENT_TOKEN;
    agent = createProviderAgent({
      serverUrl: process.env.STRAWBERRY_SERVER_URL,
      token: agentToken,
      upstreamUrl: process.env.STRAWBERRY_UPSTREAM_URL,
      name: process.env.STRAWBERRY_AGENT_NAME || undefined,
    });
  } catch (e) {
    console.error(`[provider-agent] configuration error: ${e.message}`);
    console.error('Required env: STRAWBERRY_SERVER_URL, STRAWBERRY_AGENT_TOKEN, STRAWBERRY_UPSTREAM_URL');
    process.exit(2);
  }
  agent.start().catch((e) => {
    console.error(`[provider-agent] failed to connect: ${e.message}`);
    process.exit(1);
  });
  const shutdown = (signal) => {
    log(`${signal} received; shutting down`);
    agent.stop();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createProviderAgent, handleRequestMessage, toWebSocketUrl };
