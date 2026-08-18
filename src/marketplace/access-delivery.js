// src/marketplace/access-delivery.js
// GPU アクセスの受け渡し（プロダクトの中核 — これが無いと「借りられない」）。
//
// --- なぜこの形なのか（要件そのものの訂正）---------------------------------
// 従来の実装は `virtual-gpu-manager.allocateGPU()` がマーケットプレイス GPU を
// 「割り当てる」ことになっていた。しかしサーバは**他人の家にあるマシンに対して何の権限も
// 持たない**。だから割り当ては成功を返しつつ `endpoint: null` /
// `deliveryImplemented: false` を返すしかなく、借り手は支払っても接続先を受け取れなかった。
// これは機能の未実装ではなく**要件の誤り**である。サーバが割り当てるという前提が間違っている。
//
// 正しい構造:
//   - 接続手段を作れるのは **GPU を物理的に持っているプロバイダだけ**。
//   - サーバの仕事は「仲介」— 接続情報を預かり、**支払い済みで稼働中の借り手にだけ**渡し、
//     終了時に破棄し、その全過程を監査ログに残すこと。
// これは Vast.ai / Akash など実在のマーケットが取っている形でもある（供給側のエージェントが
// 接続を用意し、マーケットは仲介と決済に徹する）。将来プロバイダ・エージェントを作るなら、
// エージェントがこの同じ API を叩けばよく、手動投入との互換は保たれる。
//
// --- 秘密情報の扱い ---------------------------------------------------------
// credential（SSH 鍵・パスワード・トークン）は**保存時に暗号化**する。data/orders.json が
// 漏れただけで全レンタルの認証情報が渡るのは論外なので、AES-256-GCM で封をして持つ。
// 復号して返すのは「その注文の借り手」だけ、「支払い済み」かつ「稼働中」の間だけ。

const { encrypt, decrypt } = require('../security/encryption');

const METHODS = Object.freeze(['ssh', 'jupyter', 'http', 'vnc', 'other']);

// 表示するだけとはいえ、javascript:/data: を接続先として受け付ける理由が無い。
// ホスト:ポート形式と、明示的に許可したスキームの URL のみ通す。
const ALLOWED_SCHEMES = Object.freeze(['ssh:', 'http:', 'https:', 'vnc:']);
const HOST_PORT_RE = /^[a-zA-Z0-9._-]+(:\d{1,5})?$/;

const MAX_ENDPOINT = 512;
const MAX_CREDENTIAL = 8192;   // SSH 秘密鍵が入る程度
const MAX_INSTRUCTIONS = 4096;
const MAX_USERNAME = 128;

function str(v, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error('expected a string');
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw new Error(`value exceeds ${max} characters`);
  return t;
}

/** 接続先の形式を検証する。ホスト:ポート、または許可スキームの URL のみ。 */
function validateEndpoint(endpoint) {
  const e = str(endpoint, MAX_ENDPOINT);
  if (!e) throw new Error('endpoint is required');
  if (e.includes('://')) {
    let u;
    try { u = new URL(e); } catch (_) { throw new Error('endpoint is not a valid URL'); }
    if (!ALLOWED_SCHEMES.includes(u.protocol)) {
      throw new Error(`endpoint scheme must be one of: ${ALLOWED_SCHEMES.join(' ')}`);
    }
    return e;
  }
  if (!HOST_PORT_RE.test(e)) {
    throw new Error('endpoint must be host, host:port, or a ssh/http/https/vnc URL');
  }
  return e;
}

/**
 * プロバイダが投入したアクセス情報を検証・正規化し、credential を封をした状態で返す。
 * @param {object} input { method, endpoint, username, credential, instructions }
 * @returns {object} 保存用レコード（credential は暗号化済み）
 */
function seal(input = {}, { now = () => new Date().toISOString() } = {}) {
  const method = input.method === undefined || input.method === null ? 'ssh' : input.method;
  if (!METHODS.includes(method)) {
    throw new Error(`method must be one of: ${METHODS.join(', ')}`);
  }
  const endpoint = validateEndpoint(input.endpoint);
  const username = str(input.username, MAX_USERNAME);
  const instructions = str(input.instructions, MAX_INSTRUCTIONS);
  const credential = str(input.credential, MAX_CREDENTIAL);

  return {
    method,
    endpoint,
    username,
    instructions,
    // 平文では絶対に保存しない。復号鍵はプロセスの ENCRYPTION_KEY にのみ存在する。
    credentialSealed: credential ? encrypt(credential) : null,
    deliveredAt: now(),
  };
}

/**
 * 借り手へ返す形へ開封する。
 * @param {object} sealed seal() が作ったレコード
 * @returns {object} { method, endpoint, username, credential, instructions, deliveredAt }
 */
function open(sealed) {
  if (!sealed) return null;
  let credential = null;
  if (sealed.credentialSealed) {
    try {
      credential = decrypt(sealed.credentialSealed);
    } catch (e) {
      // 復号失敗＝鍵の入れ替えか改ざん。中途半端な値を返さず、失敗として扱う。
      throw new Error(`stored access credential could not be decrypted: ${e.message}`);
    }
  }
  return {
    method: sealed.method,
    endpoint: sealed.endpoint,
    username: sealed.username || null,
    credential,
    instructions: sealed.instructions || null,
    deliveredAt: sealed.deliveredAt || null,
  };
}

/**
 * 秘密を伏せた要約。プロバイダ自身・管理者・一覧表示など「渡してよい相手ではないが
 * 配信済みかどうかは知ってよい」文脈で使う。
 */
function summarize(sealed) {
  if (!sealed) return { delivered: false };
  return {
    delivered: true,
    method: sealed.method,
    endpoint: sealed.endpoint,
    username: sealed.username || null,
    hasCredential: Boolean(sealed.credentialSealed),
    deliveredAt: sealed.deliveredAt || null,
  };
}

module.exports = { seal, open, summarize, validateEndpoint, METHODS, ALLOWED_SCHEMES };
