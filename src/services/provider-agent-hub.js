// src/services/provider-agent-hub.js — 提供者エージェントのサーバ側ハブ
//
// 別マシンにいる GPU 提供者は、自分のマシンから外向きに WebSocket 接続を張る
// （NAT の内側でも到達可能にするため、サーバ側から提供者へは接続しない）。
// このハブはその接続を保持し、セッションゲートウェイ（virtual-gpu-manager の
// setupNativeAccess）からのリクエストを、GPU の提供者本人のエージェントへだけ
// 中継する。
//
// 認証: 接続時の JWT を既存の jwt-auth ミドルウェアと同一手順で検証する
// （verifyWithRotation + 失効リスト + ユーザー実在/無効化チェック + セッション
// 無効化チェック）。認可の不変条件: エージェントが受け取れるのは
// 「GPU レコードの providerId が、認証されたユーザー ID と一致する」
// リクエストだけであり、ゲートウェイ側が providerId で宛先を決める。
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const { config } = require('../utils/config');
const { acceptUpgrade } = require('./ws-rfc6455');

const AGENT_PATH_SUFFIX = '/agent/connect';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

// jwt-auth ミドルウェアと同じ検証手順（HTTP レスポンスではなく boolean で返す）。
function authenticateAgentRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const { verifyWithRotation } = require('../api/middleware/jwt-auth');
    const { isRevoked } = require('../api/middleware/token-denylist');
    const payload = verifyWithRotation(token);
    if (payload.type === 'refresh') return null;
    if (payload.jti && isRevoked(payload.jti)) return null;
    const { getAuthUser } = require('../api/utils/auth-user-lookup');
    const tokenUser = getAuthUser(payload.id);
    if (!tokenUser || tokenUser.status === 'deactivated') return null;
    const { isSessionInvalidated } = require('../api/utils/session-invalidation');
    if (isSessionInvalidated(tokenUser, payload.iat)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function rejectUpgrade(socket, status, message) {
  try {
    const body = JSON.stringify({ error: message });
    socket.write(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' + body
    );
    socket.end();
  } catch (_) {
    try { socket.destroy(); } catch (__) { /* noop */ }
  }
}

// 応答ヘッダからホップバイホップ系と不整合な content-length を落とす。
function sanitizeResponseHeaders(headers, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (['connection', 'transfer-encoding', 'keep-alive', 'content-length'].includes(key)) continue;
    out[key] = v;
  }
  out['content-length'] = bodyLength;
  return out;
}

class ProviderAgentHub {
  constructor() {
    this._byProvider = new Map(); // providerId -> Set<agentConn>
    this._attachedServer = null;
  }

  agentPath() {
    const prefix = (config.server && config.server.apiPrefix) || '/api/v1';
    return `${prefix}${AGENT_PATH_SUFFIX}`;
  }

  attachToServer(server) {
    if (this._attachedServer === server) return;
    this._attachedServer = server;
    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { pathname = ''; }
      if (pathname !== this.agentPath()) {
        // このサーバに他の WebSocket エンドポイントは無い。Node 既定の挙動
        // （upgrade リスナが無ければ破棄）に合わせて黙って切る。
        socket.destroy();
        return;
      }
      const payload = authenticateAgentRequest(req);
      if (!payload || !payload.id) {
        rejectUpgrade(socket, 401, 'Unauthorized: a valid provider access token is required');
        return;
      }
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) {
        rejectUpgrade(socket, 400, 'Bad WebSocket handshake');
        return;
      }
      this._register(payload.id, conn);
    });
    server.on('close', () => this.closeAll());
  }

  _register(providerId, ws) {
    const agent = {
      providerId,
      ws,
      connectedAt: Date.now(),
      pending: new Map(),
      heartbeatTimer: null,
      awaitingPongSince: null,
      hello: null,
    };
    let set = this._byProvider.get(providerId);
    if (!set) { set = new Set(); this._byProvider.set(providerId, set); }
    set.add(agent);
    logger.info(`Provider agent connected: provider=${providerId} (total ${set.size})`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // プロトコルは JSON テキストのみ
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.type === 'hello') {
        agent.hello = { agent: msg.agent || null, version: msg.version || null, gpus: Array.isArray(msg.gpus) ? msg.gpus : [] };
        return;
      }
      if (msg.type === 'response' && msg.id && agent.pending.has(msg.id)) {
        const entry = agent.pending.get(msg.id);
        agent.pending.delete(msg.id);
        clearTimeout(entry.timer);
        const body = msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : Buffer.alloc(0);
        entry.resolve({
          status: Number.isInteger(msg.status) ? msg.status : 502,
          headers: sanitizeResponseHeaders(msg.headers, body.length),
          body,
        });
      }
    });
    ws.on('pong', () => { agent.awaitingPongSince = null; });
    const cleanup = () => {
      clearInterval(agent.heartbeatTimer);
      const s = this._byProvider.get(providerId);
      if (s) {
        s.delete(agent);
        if (s.size === 0) this._byProvider.delete(providerId);
      }
      for (const entry of agent.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(Object.assign(new Error('provider agent disconnected'), { code: 'AGENT_DISCONNECTED' }));
      }
      agent.pending.clear();
      logger.info(`Provider agent disconnected: provider=${providerId}`);
    };
    ws.on('close', cleanup);
    ws.on('error', () => { /* close が続く */ });

    // ハートビート: ping に pong が返らなければ死活不明として切断する。
    const heartbeatMs = envInt('STRAWBERRY_AGENT_HEARTBEAT_MS', 30000);
    agent.heartbeatTimer = setInterval(() => {
      if (agent.awaitingPongSince && Date.now() - agent.awaitingPongSince > heartbeatMs) {
        ws.destroy();
        return;
      }
      agent.awaitingPongSince = Date.now();
      ws.ping();
    }, heartbeatMs);
    if (agent.heartbeatTimer.unref) agent.heartbeatTimer.unref();
  }

  hasProvider(providerId) {
    const set = this._byProvider.get(providerId);
    return !!set && set.size > 0;
  }

  connectedProviderIds() {
    return [...this._byProvider.keys()];
  }

  _pickAgent(providerId) {
    const set = this._byProvider.get(providerId);
    if (!set || set.size === 0) return null;
    // 最も新しく接続したエージェントを使う（再接続直後の古い接続を避ける）。
    let newest = null;
    for (const agent of set) {
      if (!newest || agent.connectedAt > newest.connectedAt) newest = agent;
    }
    return newest;
  }

  // ゲートウェイ → エージェント → 提供者の上流、の一往復。
  // body は Buffer。応答は { status, headers, body:Buffer }。
  forward(providerId, { method, path, headers, body }) {
    const agent = this._pickAgent(providerId);
    if (!agent) {
      return Promise.reject(Object.assign(
        new Error('provider agent is not connected'),
        { code: 'AGENT_OFFLINE' }
      ));
    }
    const timeoutMs = envInt('STRAWBERRY_AGENT_REQUEST_TIMEOUT_MS', 120000);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pending.delete(id);
        reject(Object.assign(new Error('provider agent request timed out'), { code: 'AGENT_TIMEOUT' }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      agent.pending.set(id, { resolve, reject, timer });
      try {
        agent.ws.sendText(JSON.stringify({
          type: 'request',
          id,
          method,
          path,
          headers: headers || {},
          bodyBase64: body && body.length ? body.toString('base64') : '',
        }));
      } catch (e) {
        agent.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  closeAll() {
    for (const set of this._byProvider.values()) {
      for (const agent of set) {
        clearInterval(agent.heartbeatTimer);
        agent.ws.destroy();
      }
    }
    this._byProvider.clear();
  }
}

// プロセス内シングルトン（サーバと virtual-gpu-manager が同じレジストリを見る）。
const hub = new ProviderAgentHub();

module.exports = { ProviderAgentHub, hub, authenticateAgentRequest };
