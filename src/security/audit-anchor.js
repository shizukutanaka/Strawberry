// src/security/audit-anchor.js
// 監査ログの Merkle アンカリング結線（docs/SPECIFICATION.md F4）。
// `src/utils/audit-log.js` は HMAC ハッシュチェーンで tamper-evident だが、運営自身が
// 全ログ＋チェーンを書き換えれば遡及改ざんを否認できてしまう。本モジュールは監査ログの
// エントリ集合を `src/security/merkle-anchor.js` で Merkle 木に集約し、root を含む
// アンカー・ダイジェストを生成・永続化する。root を公開タイムスタンプ(OpenTimestamps 等)へ
// 提出すれば、第三者がその時点のログ状態を否認できる「非否認性」が確立する（提出は別途）。
//
// コアは純関数（エントリ配列を注入してテスト可能）、ファイル I/O は薄いラッパに分離。
const fs = require('fs');
const path = require('path');
const { merkleRoot, merkleProof, verifyProof, buildAnchor } = require('./merkle-anchor');

const AUDIT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');
const ANCHOR_PATH = path.join(__dirname, '../../logs/audit-anchors.jsonl');

/** JSONL 文字列を 1 行 1 エントリの配列へパース（壊れた行はスキップ）。 */
function parseEntries(text) {
  if (!text) return [];
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // 壊れた行は無視（部分書込み等）
    }
  }
  return entries;
}

/**
 * エントリ集合からアンカー・ダイジェストを構築する純関数。
 * buildAnchor に加え、対象範囲（fromIndex/toIndex）を記録して増分アンカーに対応。
 * @param {Array<object>} entries 監査ログエントリ
 * @param {object} opts { now, fromIndex } now はテスト用に時刻を注入
 * @returns {{algorithm,root,count,createdAt,fromIndex,toIndex}}
 */
function buildAuditAnchor(entries, { now = () => new Date().toISOString(), fromIndex = 0 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array');
  }
  const anchor = buildAnchor(entries, { now });
  return { ...anchor, fromIndex, toIndex: fromIndex + entries.length - 1 };
}

/** index 番目のエントリの包含証明を返す（merkle-anchor へ委譲）。 */
function proveEntry(entries, index) {
  return merkleProof(entries, index);
}

/** 葉データ＋包含証明＋root で、その時点のアンカーにエントリが含まれていたか検証。 */
function verifyEntryInclusion(entry, proof, rootHex) {
  return verifyProof(entry, proof, rootHex);
}

/**
 * 監査ログファイルを読み、全エントリのアンカーを構築して anchor ファイルへ追記する。
 * I/O ラッパ。ファイルが無い/空なら null を返す（何もアンカーしない）。
 * @param {object} opts { logPath, anchorPath, now }
 * @returns {object|null} 追記したアンカー
 */
function anchorAuditLogFile({ logPath = AUDIT_LOG_PATH, anchorPath = ANCHOR_PATH, now } = {}) {
  if (!fs.existsSync(logPath)) return null;
  const entries = parseEntries(fs.readFileSync(logPath, 'utf-8'));
  if (entries.length === 0) return null;

  const anchor = buildAuditAnchor(entries, { now });
  fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
  fs.appendFileSync(anchorPath, JSON.stringify(anchor) + '\n');
  return anchor;
}

/** 既存アンカー一覧を読み出す（監査・OTS 提出バッチ用）。 */
function readAnchors(anchorPath = ANCHOR_PATH) {
  if (!fs.existsSync(anchorPath)) return [];
  return parseEntries(fs.readFileSync(anchorPath, 'utf-8'));
}

module.exports = {
  buildAuditAnchor,
  proveEntry,
  verifyEntryInclusion,
  anchorAuditLogFile,
  readAnchors,
  parseEntries,
  merkleRoot, // 再エクスポート（呼び出し側の利便）
  AUDIT_LOG_PATH,
  ANCHOR_PATH,
};
