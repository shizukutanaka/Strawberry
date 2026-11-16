// src/services/ws-rfc6455.js — 最小限の WebSocket (RFC 6455) 実装（Node 標準のみ）
//
// 提供者エージェントのトンネル専用。外部依存（ws 等）を追加せずに
// サーバ側（HTTP Upgrade の受理）とクライアント側（外向き接続）の両方を賄う。
// 対応範囲: text/binary フレーム、断片化の再組立、ping/pong、close。
// サーバ→クライアントは無マスク、クライアント→サーバはマスク必須（RFC 準拠）。
// メッセージ上限を超えたら 1009 で切断する（メモリ枯渇防止）。
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 16MB（base64 化された HTTP ボディ用）

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload, { fin = true, mask = false } = {}) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  if (mask) headerLen += 4;
  const frame = Buffer.alloc(headerLen + len);
  frame[0] = (fin ? 0x80 : 0x00) | opcode;
  let offset = 2;
  if (len < 126) {
    frame[1] = len;
  } else if (len < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (mask) {
    frame[1] |= 0x80;
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) frame[offset + i] = payload[i] ^ maskKey[i % 4];
  } else {
    payload.copy(frame, offset);
  }
  return frame;
}

// 1 接続分のフレーム解析と送受信を担う。isServer=true のとき受信フレームの
// マスクを必須とし、送信は無マスク。クライアント側はその逆。
class WebSocketConnection extends EventEmitter {
  constructor(socket, { isServer, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super();
    this.socket = socket;
    this.isServer = !!isServer;
    this.maxMessageBytes = maxMessageBytes;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._fragmentBytes = 0;
    this.closed = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._onSocketClose());
    if (socket.setNoDelay) socket.setNoDelay(true);
  }

  sendText(text) {
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  sendBinary(buf) {
    this._sendFrame(0x2, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try { this._sendFrame(0x8, payload); } catch (_) { /* 送信失敗は無視して閉じる */ }
    this.closed = true;
    try { this.socket.end(); } catch (_) { /* noop */ }
    this.emit('close', code, reason);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (_) { /* noop */ }
    this.emit('close', 1006, 'socket destroyed');
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(encodeFrame(opcode, payload, { mask: !this.isServer }));
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.emit('error', err);
    this.emit('close', 1006, err.message);
    try { this.socket.destroy(); } catch (_) { /* noop */ }
  }

  _onSocketClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', 1006, 'socket closed');
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const frame = this._tryParseFrame();
      if (!frame) return;
      if (frame.error) {
        this.close(1002, frame.error);
        return;
      }
      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.toString('utf8', 2) : '';
        if (!this.closed) {
          // close には close で応答してから切る（RFC 6455 §5.5.1）
          try { this._sendFrame(0x8, payload); } catch (_) { /* noop */ }
          this.closed = true;
          try { this.socket.end(); } catch (_) { /* noop */ }
          this.emit('close', code, reason);
        }
        return;
      }
      if (opcode === 0x9) { // ping → pong
        this._sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) { // pong
        this.emit('pong');
        continue;
      }
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        if (opcode !== 0x0) {
          if (this._fragmentOpcode !== null) { this.close(1002, 'new message before fragments completed'); return; }
          this._fragmentOpcode = opcode;
          this._fragments = [];
          this._fragmentBytes = 0;
        } else if (this._fragmentOpcode === null) {
          this.close(1002, 'unexpected continuation frame');
          return;
        }
        this._fragments.push(payload);
        this._fragmentBytes += payload.length;
        if (this._fragmentBytes > this.maxMessageBytes) {
          this.close(1009, 'message too large');
          return;
        }
        if (fin) {
          const message = Buffer.concat(this._fragments);
          const messageOpcode = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = null;
          this._fragmentBytes = 0;
          if (messageOpcode === 0x1) this.emit('message', message.toString('utf8'), false);
          else this.emit('message', message, true);
        }
        continue;
      }
      this.close(1002, `unknown opcode ${opcode}`);
      return;
    }
  }

  _tryParseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) return { error: 'frame too large' };
      len = Number(big);
      offset = 10;
    }
    // RFC 6455: クライアント→サーバはマスク必須、サーバ→クライアントはマスク禁止。
    if (this.isServer && !masked) return { error: 'client frames must be masked' };
    if (!this.isServer && masked) return { error: 'server frames must not be masked' };
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

// サーバ側: HTTP Upgrade リクエストを WebSocket として受理する。
// 検証に失敗したら false を返し、ソケットは呼び出し側が破棄する。
function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key) return false;
  const accept = computeAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );
  const conn = new WebSocketConnection(socket, { isServer: true });
  if (head && head.length) conn._onData(head);
  return conn;
}

// クライアント側: ws:// / wss:// へ外向き接続する。headers に認証等を渡せる。
// 接続確立で WebSocketConnection を resolve する Promise を返す。
function connectClient(urlString, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (e) { reject(e); return; }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      reject(new Error(`unsupported websocket protocol: ${url.protocol}`));
      return;
    }
    const isTls = url.protocol === 'wss:';
    const lib = isTls ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      timeout: timeoutMs,
    });
    let settled = false;
    req.on('upgrade', (res, socket, head) => {
      settled = true;
      const expected = computeAccept(key);
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      const conn = new WebSocketConnection(socket, { isServer: false });
      if (head && head.length) conn._onData(head);
      resolve(conn);
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      res.resume();
      reject(new Error(`websocket handshake failed: HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => { req.destroy(new Error('websocket connect timed out')); });
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    req.end();
  });
}

module.exports = { WebSocketConnection, acceptUpgrade, connectClient, computeAccept };
