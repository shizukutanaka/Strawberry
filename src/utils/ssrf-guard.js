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
    const g = expandIpv6(addr);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true;                       // :: unspecified
    if (g[7] === 1 && g.slice(0, 7).every((x) => x === 0)) return true; // ::1 loopback
    // IPv4-compatible (::/96) と IPv4-mapped (::ffff:0:0/96): 末尾32bitを
    // IPv4 として再分類する。'::7f00:1' や '::ffff:0a00:1'（16進テール形式）の
    // ようなループバック/RFC1918 埋め込みを検出するため。
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0
        && (g[5] === 0 || g[5] === 0xffff)) {
      const v4 = `${g[6] >>> 8}.${g[6] & 255}.${g[7] >>> 8}.${g[7] & 255}`;
      return isPrivateIp(v4);
    }
    if ((g[0] & 0xffc0) === 0xfe80) return true;  // link-local fe80::/10 (fe80〜febf)
    if ((g[0] & 0xffc0) === 0xfec0) return true;  // site-local fec0::/10 (deprecated)
    if ((g[0] & 0xfe00) === 0xfc00) return true;  // unique-local fc00::/7
    if ((g[0] & 0xff00) === 0xff00) return true;  // multicast ff00::/8
    // IPv4 を埋め込む遷移機構・予約済み特殊用途: 到達側で内部 IPv4 に化けるため全遮断。
    if (g[0] === 0x2002) return true;             // 6to4 2002::/16
    if (g[0] === 0x2001 && g[1] === 0) return true;         // Teredo 2001:0::/32
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true;     // documentation 2001:db8::/32
    if (g[0] === 0x64 && g[1] === 0xff9b
        && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return true; // NAT64 64:ff9b::/96
    return false;
  }

  return true; // 有効な IP として解釈できない → ブロック
}

// IPv6 アドレスを 8 つの 16bit グループへ展開する。'::' 圧縮とドット4系テール
// （'::ffff:127.0.0.1' 形式）の両方に対応。解釈不能なら null（呼び出し側でブロック）。
function expandIpv6(addr) {
  let a = addr.toLowerCase();
  // ドット4系テールを2グループの16進へ変換（net.isIP 検証済みの前提だが一応検査）。
  const m = a.match(/^(.*):(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const v4 = `${m[2]}.${m[3]}.${m[4]}.${m[5]}`;
    if (net.isIP(v4) !== 4) return null;
    const [b1, b2, b3, b4] = v4.split('.').map(Number);
    a = `${m[1]}:${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  let groups;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const right = halves[1] === '' ? [] : halves[1].split(':');
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array(missing).fill('0'), ...right];
  }
  if (groups.length !== 8 || groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return groups.map((x) => parseInt(x, 16));
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

  // 明示的オプトインで private/loopback 宛を許可する（既定は無効＝安全側）。
  // セルフホスト環境で内部 Webhook（社内 Slack 互換エンドポイント等）へ送る正当な
  // ユースケースのための逃げ道。本番でこれを有効化するのは利用者の判断と責任に委ねる。
  const allowPrivate = process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS === 'true'
    || process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS === '1';
  if (allowPrivate) return true;

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

// assertPublicUrl() で検証した URL へ送る axios の共通安全設定。
// maxRedirects:0 が本ガード成立の前提条件: 検証は「最初の URL」のホスト名だけを
// 解決するため、axios 既定（maxRedirects:5）でリダイレクト追従を許すと、
// 検証を通過した公開 URL が 30x で 127.0.0.1 や 169.254.169.254（クラウド
// メタデータ）へ誘導でき、ガードを完全に迂回される。timeout/サイズ上限は
// 攻撃者管理エンドポイントの無限レスポンスによる DoS 防止。
// assertPublicUrl を通した呼び出しは必ずこの設定を併用すること。
const SAFE_AXIOS_CONFIG = Object.freeze({
  timeout: 10_000,               // 10 秒でタイムアウト
  maxContentLength: 1_048_576,   // レスポンスボディ上限 1 MiB
  maxBodyLength: 1_048_576,      // リクエストボディ上限 1 MiB
  maxRedirects: 0,               // リダイレクト追従禁止（SSRF リダイレクト迂回を遮断）
});

module.exports = { isPrivateIp, assertPublicUrl, SAFE_AXIOS_CONFIG };
