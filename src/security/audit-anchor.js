// src/security/audit-anchor.js
// 監査ログの Merkle アンカリング結線（docs/SPECIFICATION.md F4 / 研究ドキュメント §18）。
// `src/utils/audit-log.js` は HMAC ハッシュチェーンで tamper-evident だが、運営自身が
// 全ログ＋チェーンを書き換えれば遡及改ざんを否認できてしまう（自己署名の限界）。本モジュールは
// 監査ログのエントリ集合を `src/security/merkle-anchor.js` で Merkle 木に集約し、root を含む
// アンカー・ダイジェストを生成・永続化する。root を公開タイムスタンプ(OpenTimestamps)へ
// 提出することで、第三者がその時点のログ状態を否認できない状態を作る
// （提出は `src/security/ots-client.js`、定期実行は `src/security/anchor-scheduler.js`）。
//
// 参考: Haber & Stornetta (1991) ハッシュ連鎖＋分散した信頼 / Merkle (1980) ハッシュ木 /
//       RFC 6962 Certificate Transparency（append-only ログと包含証明の実運用形）。
//
// コアは純関数（エントリ配列を注入してテスト可能）、ファイル I/O は薄いラッパに分離。
const fs = require('fs');
const path = require('path');
const { merkleRoot, merkleProof, verifyProof, buildAnchor } = require('./merkle-anchor');

const DEFAULT_LOG_PATH = path.join(__dirname, '../../logs/audit.log');
const DEFAULT_ANCHOR_PATH = path.join(__dirname, '../../logs/audit-anchors.jsonl');

// パスは呼び出し時に解決する。旧実装はモジュール読込時に定数化しており、
// `audit-log.js` が呼び出しごとに `process.env.AUDIT_LOG_PATH` を見るのと食い違っていた。
// その結果 AUDIT_LOG_PATH を設定した環境（およびテスト分離）で、アンカラーが
// 実際の監査ログとは別のファイルを見るというバグになっていた。
function auditLogPath() {
  return process.env.AUDIT_LOG_PATH || DEFAULT_LOG_PATH;
}
function anchorFilePath() {
  return process.env.AUDIT_ANCHOR_PATH || DEFAULT_ANCHOR_PATH;
}

// アンカリング自体も監査ログにエントリを残すため、そのエントリだけを理由に次サイクルが
// 起動すると「アンカーを作る→ログが1件増える→またアンカーを作る」の空回りが無限に続く。
// 木には含めつつ（インデックスをログ行番号と一致させるため）、起動判定からは除外する。
const ANCHOR_BOOKKEEPING_PREFIX = 'audit_anchor_';

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
 * ログファイルの指定バイト位置以降を読み、完全な行だけをエントリへパースする。
 *
 * 末尾の改行までしか消費しないのが要点。appendFileSync 中のクラッシュ等で行が途中まで
 * しか書かれていない場合、それをスキップしつつオフセットだけ進めるとそのエントリは
 * 二度とアンカーされない（＝監査証跡に穴が空く）。次サイクルで完全な行として読み直せるよう、
 * 最後の改行の直後までを consumed とする。
 *
 * @param {string} logPath
 * @param {number} startOffset 前回アンカー済みの終端バイト位置
 * @returns {{entries:Array<object>, endOffset:number, truncated:boolean}}
 */
function readEntriesFrom(logPath, startOffset = 0) {
  if (!fs.existsSync(logPath)) return { entries: [], endOffset: 0, truncated: false };
  const size = fs.statSync(logPath).size;
  // ログが縮んでいる＝ローテーション/削除/切詰め。オフセットは無効なので先頭から読み直す。
  if (size < startOffset) return { entries: [], endOffset: 0, truncated: true };
  if (size === startOffset) return { entries: [], endOffset: startOffset, truncated: false };

  const length = size - startOffset;
  const buf = Buffer.allocUnsafe(length);
  const fd = fs.openSync(logPath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, startOffset);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf-8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    // 完全な行が 1 つも無い（書込み途中）。何も消費しない。
    return { entries: [], endOffset: startOffset, truncated: false };
  }
  const complete = text.slice(0, lastNewline + 1);
  return {
    entries: parseEntries(complete),
    endOffset: startOffset + Buffer.byteLength(complete, 'utf-8'),
    truncated: false,
  };
}

/** 既存アンカー一覧を読み出す（監査・OTS 提出バッチ用）。 */
function readAnchors(anchorPath = anchorFilePath()) {
  if (!fs.existsSync(anchorPath)) return [];
  return parseEntries(fs.readFileSync(anchorPath, 'utf-8'));
}

/** 直近のアンカー（無ければ null）。 */
function lastAnchor(anchorPath = anchorFilePath()) {
  const all = readAnchors(anchorPath);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * 前回アンカー以降の新規エントリだけをアンカーする（増分アンカリング）。
 *
 * 旧 `anchorAuditLogFile()` は毎回ログ全体を読んで fromIndex=0 で全件アンカーしていたため、
 * 呼ぶたびに範囲が重複したアンカーが増え続け、50MB 上限のログを毎サイクル全パースする
 * ことになっていた。ここでは直近アンカーの `toByteOffset` から末尾だけを読む。
 *
 * @param {object} opts { logPath, anchorPath, now }
 * @returns {object|null} 追記したアンカー。新規エントリが無い/簿記エントリのみなら null
 */
function anchorNewEntries({ logPath = auditLogPath(), anchorPath = anchorFilePath(), now } = {}) {
  const prev = lastAnchor(anchorPath);
  let startOffset = prev && typeof prev.toByteOffset === 'number' ? prev.toByteOffset : 0;
  let startIndex = prev && typeof prev.toIndex === 'number' ? prev.toIndex + 1 : 0;

  let read = readEntriesFrom(logPath, startOffset);
  // 再読み込みするとフラグが落ちるので、検出したことをここで保持しておく。
  const truncated = read.truncated;
  if (read.truncated) {
    // ログが切り詰められた/差し替えられた。インデックス空間が壊れているので先頭から再開する。
    // 検出できたこと自体が重要な監査事実なので、呼び出し元（scheduler）が記録する。
    startOffset = 0;
    startIndex = 0;
    read = readEntriesFrom(logPath, 0);
  }
  if (read.entries.length === 0) return null;

  // アンカリング自身の簿記エントリしか無いなら空回り。木は作らない。
  const hasRealActivity = read.entries.some(
    (e) => !(e && typeof e.action === 'string' && e.action.startsWith(ANCHOR_BOOKKEEPING_PREFIX))
  );
  if (!hasRealActivity) return null;

  const anchor = {
    ...buildAuditAnchor(read.entries, { now, fromIndex: startIndex }),
    fromByteOffset: startOffset,
    toByteOffset: read.endOffset,
    // アンカー列を連鎖させる。範囲ごと削除されたことを、アンカーファイル単体からも
    // 検出できるようにするため（RFC 6962 の consistency proof の代替にはならない。
    // 限界は docs/improvement-research-2026.md §18 に明記）。
    prevAnchorRoot: prev ? prev.root : null,
    truncationDetected: truncated || undefined,
  };

  fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
  fs.appendFileSync(anchorPath, JSON.stringify(anchor) + '\n');
  return anchor;
}

/**
 * 監査ログファイルを読み、全エントリのアンカーを構築して anchor ファイルへ追記する。
 * 全件アンカー（増分ではない）。既存の呼び出し・テスト互換のため残す。
 * 定期実行には `anchorNewEntries()` を使うこと。
 * @param {object} opts { logPath, anchorPath, now }
 * @returns {object|null} 追記したアンカー
 */
function anchorAuditLogFile({ logPath = auditLogPath(), anchorPath = anchorFilePath(), now } = {}) {
  if (!fs.existsSync(logPath)) return null;
  const entries = parseEntries(fs.readFileSync(logPath, 'utf-8'));
  if (entries.length === 0) return null;

  const anchor = buildAuditAnchor(entries, { now });
  fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
  fs.appendFileSync(anchorPath, JSON.stringify(anchor) + '\n');
  return anchor;
}

/**
 * グローバルなエントリ index を含むアンカーを探し、そのエントリの包含証明を返す。
 * 第三者が「このエントリはアンカー時点のログに確かに含まれていた」を検証するための材料。
 * @param {number} index 監査ログ全体での 0 始まりインデックス
 * @param {object} opts { logPath, anchorPath }
 * @returns {{anchor:object, entry:object, proof:Array, localIndex:number}|null}
 */
function proveEntryAtIndex(index, { logPath = auditLogPath(), anchorPath = anchorFilePath() } = {}) {
  if (!Number.isInteger(index) || index < 0) return null;
  const anchor = readAnchors(anchorPath).find(
    (a) => typeof a.fromIndex === 'number' && typeof a.toIndex === 'number'
      && index >= a.fromIndex && index <= a.toIndex
  );
  if (!anchor) return null;

  // アンカーが記録したバイト範囲をそのまま読み直して木を再構築する。
  // fromByteOffset を持たない旧形式のアンカーは全件読みにフォールバックする。
  let entries;
  if (typeof anchor.fromByteOffset === 'number' && typeof anchor.toByteOffset === 'number') {
    const read = readEntriesFrom(logPath, anchor.fromByteOffset);
    entries = read.entries.slice(0, anchor.count);
  } else {
    entries = parseEntries(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '')
      .slice(anchor.fromIndex, anchor.toIndex + 1);
  }
  if (entries.length !== anchor.count) return null; // ログが変わっている＝再構築不能

  const localIndex = index - anchor.fromIndex;
  return { anchor, entry: entries[localIndex], proof: proveEntry(entries, localIndex), localIndex };
}

module.exports = {
  buildAuditAnchor,
  proveEntry,
  proveEntryAtIndex,
  verifyEntryInclusion,
  anchorAuditLogFile,
  anchorNewEntries,
  readEntriesFrom,
  readAnchors,
  lastAnchor,
  parseEntries,
  merkleRoot, // 再エクスポート（呼び出し側の利便）
  auditLogPath,
  anchorFilePath,
  ANCHOR_BOOKKEEPING_PREFIX,
};
