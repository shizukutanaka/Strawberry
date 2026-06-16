// src/utils/ssrf-guard.js
// SSRF 対策の中核。Webhook 等の外向き HTTP 送信先が内部/予約ネットワークを指していないかを
// 「実際に名前解決した IP」で判定する。
//
// 既存の正規表現チェック（notification-settings.js）は URL 文字列に現れるリテラル private IP
// しか弾けず、以下をすり抜ける:
//   - DNS リバインディング / 内部ホスト名: evil.example.com が 127.0.0.1 に解決される
//   - 代替エンコード: http://2130706433/ (=127.0.0.1), http://0x7f000001/ など
// これらは「ホスト名を解決して得た IP」を分類することで初めて検出できる。
//
// 既知の残存リスク（許容）: 検証から実接続までの間に DNS が差し替わる TOCTOU。
// 完全な遮断には接続時 IP ピン留めが要るが、本ガードで実用的な攻撃面の大半を塞ぐ。
const dns = require('dns');
const net = require('net');

// 与えられた IP 文字列が private/loopback/link-local/予約 かどうかを判定する純関数。
// 不正な入力は安全側に倒して true（ブロック）を返す。
function isPrivateIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return true;
  let addr = ip.trim();

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) は内側の IPv4 として評価する。
  const lowered = addr.toLowerCase();
  if (lowered.startsWith('::ffff:')) {
    const tail = addr.slice(addr.lastIndexOf(':') + 1);
    if (net.isIP(tail) === 4) addr = tail;
  }

  const kind = net.isIP(addr);
  if (kind === 4) {
    const parts = addr.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true;                         // 0.0.0.0/8 "this network"
    if (a === 10) return true;                        // RFC1918 10/8
    if (a === 127) return true;                       // loopback 127/8
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;          // link-local + cloud metadata 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
    if (a === 192 && b === 0) return true;            // 192.0.0/24 & 192.0.2/24 (special-use/TEST-NET)
    if (a === 192 && b === 168) return true;          // RFC1918 192.168/16
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
    if (a >= 224) return true;                        // multicast 224/4 + reserved 240/4
    return false;
  }

  if (kind === 6) {
    const low = lowered;
    if (low === '::1') return true;        // loopback
    if (low === '::') return true;         // unspecified
    if (low.startsWith('fe80')) return true; // link-local fe80::/10
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local fc00::/7
    if (low.startsWith('ff')) return true; // multicast ff00::/8
    return false;
  }

  return true; // 有効な IP として解釈できない → ブロック
}

// URL のホスト名を解決し、得られた全 IP が公開アドレスであることを保証する。
// 一つでも private/予約 に該当すれば throw する。スキームは http/https のみ許可。
// @param {string} url
// @param {(hostname:string)=>Promise<Array<{address:string}>>} [resolver] テスト用注入
async function assertPublicUrl(url, resolver) {
  if (!url || typeof url !== 'string') {
    throw new Error('SSRF blocked: empty or non-string URL');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`SSRF blocked: malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF blocked: unsupported scheme: ${parsed.protocol}`);
  }
  // URL の hostname は IPv6 の場合 [] を含むので除去する。
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // ホスト名がリテラル IP ならそのまま分類（DNS を引かない）。
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`SSRF blocked: ${hostname} is a private/reserved address`);
    }
    return true;
  }

  // それ以外は名前解決して、返ってきた全アドレスを検査する。
  const lookup = resolver || ((h) => dns.promises.lookup(h, { all: true }));
  let addresses;
  try {
    addresses = await lookup(hostname);
  } catch (e) {
    throw new Error(`SSRF blocked: DNS resolution failed for ${hostname}: ${e.message}`);
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (list.length === 0) {
    throw new Error(`SSRF blocked: ${hostname} resolved to no addresses`);
  }
  for (const entry of list) {
    const address = typeof entry === 'string' ? entry : entry && entry.address;
    if (isPrivateIp(address)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private address ${address}`);
    }
  }
  return true;
}

module.exports = { isPrivateIp, assertPublicUrl };
