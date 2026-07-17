// src/api/middleware/ip-key.js
// レート制限キー生成の共有ヘルパー。rate-limit.js と security.js の双方が使う
// 単一の真実源（ロジックが二重化してドリフトするのを防ぐ）。
const net = require('net');

// IPv6 アドレスを /64 サブネットに正規化する。
// 理由（レート制限回避の防止）: IPv6 では 1 顧客に /64（2^64 アドレス）が割り当てられるのが
// 標準。生 IP をそのままキーにすると、攻撃者は同一 /64 内でアドレスを回し続けるだけで
// アドレス毎に別バケットを得て authLimiter（ブルートフォース対策）を完全にすり抜けられる。
// 同一 /64 を 1 つのキーに畳み込むことで「1 割り当て = 1 レート制限対象」にする。
// IPv4 / IPv4-mapped はそのまま返す（IPv4 は単一アドレス単位で十分）。
function normalizeIpKey(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return 'unknown';
  const addr = ip.trim();
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) は内側の IPv4 として扱う。
  if (addr.toLowerCase().startsWith('::ffff:')) {
    const tail = addr.slice(addr.lastIndexOf(':') + 1);
    if (net.isIP(tail) === 4) return tail;
  }
  if (net.isIP(addr) !== 6) return addr; // IPv4 またはホスト名等はそのまま
  // IPv6 を 8 ハクテットに展開し、先頭 4 ハクテット（/64）を取り出す。
  const zoneStripped = addr.split('%')[0]; // link-local の %zone を除去
  const halves = zoneStripped.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  const groups = halves.length > 1
    ? [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail]
    : head;
  // 異常系（展開して 8 群にならない）は安全側で生アドレスをキーにする。
  if (groups.length < 4) return zoneStripped;
  const prefix = groups.slice(0, 4).map(g => (g === '' ? '0' : g)).join(':');
  return `${prefix}::/64`;
}

// X-Forwarded-For 偽装によるレート制限回避を防ぐ生 IP の選択。
// TRUST_PROXY を hop 数（正の整数: 1, 2, …）として解釈する。
// 'true' / 'yes' 等のブーリアン文字列は意図的に拒否する:
//   Express app.set('trust proxy', true) は全 hop を信頼するため、X-Forwarded-For の
//   左端（完全に攻撃者制御）が req.ip になり、送信元 IP を偽装してバイパスできてしまう。
// 整数 hop 数のときのみ req.ip（プロキシ解決済み）を信頼し、それ以外は実 TCP ピアを使う。
function rawClientIp(req) {
  const hopCount = parseInt(process.env.TRUST_PROXY, 10);
  if (Number.isInteger(hopCount) && hopCount > 0) {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || req.ip || 'unknown';
}

// express-rate-limit 用 keyGenerator: XFF 耐性のある IP 選択 + IPv6 /64 畳み込み。
function rateLimitKeyGenerator(req) {
  return normalizeIpKey(rawClientIp(req));
}

module.exports = { normalizeIpKey, rawClientIp, rateLimitKeyGenerator };
