// src/db/json/createJsonRepository.js
// 7つのJSONリポジトリ（Gpu/Order/Payment/User/Escrow/Reputation/Verification）の
// 重複していた load/save/CRUD 実装を一本化するファクトリ。
// すべての書き込みは atomicWriteJSON（temp+rename）経由で行う。
//
// 契約:
//  - getById / 単一ファインダは「見つからなければ null」を返す
//    （サービス層テストのモックと同一契約。旧実装の undefined も falsy のため互換)
//  - create は id を必ず採番し直し、createdAt は呼び出し側指定があれば尊重する
//  - finders: { name: { field, many } } で getByXxx を宣言的に生成する
//  - onAccess(action, detail): 監査フック（UserRepository の db-access.log 用）。
//    フックの失敗は本処理に影響させない。
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { atomicWriteJSON } = require('./atomicWrite');

// プロトタイプ汚染対策（深層防御）。全リポジトリの create/update/updateIf がこの
// チョークポイントを通るため、ここで危険キーを一括除去する。
// オブジェクトスプレッド（{ ...a, ...b }）自体は "__proto__" を own プロパティとして
// コピーするだけで Object.prototype を汚染しないが、JSON.parse 由来の
// "__proto__"/"constructor"/"prototype" キーがそのまま data/*.json に永続化されると、
// 読み戻し後の別経路（bracket 代入・deep merge 等）で汚染の起点になりうる。
// 上流の Joi 検証に依存せず、書き込み直前で確実に弾く。
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
function stripDangerousKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  let cleaned = obj;
  for (const k of DANGEROUS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      if (cleaned === obj) cleaned = { ...obj };
      delete cleaned[k];
    }
  }
  return cleaned;
}

function createJsonRepository(fileName, { finders = {}, onAccess } = {}) {
  // fileName はリテラル文字列のみを期待する（呼び出し側は全てコード内定数）。
  // path.resolve の仕様上 fileName が絶対パスであれば data/ プレフィックスを無効化できる
  // ため、将来の開発者が誤って変数を渡した場合のパストラバーサルを事前に排除する。
  if (
    typeof fileName !== 'string' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    !fileName.endsWith('.json')
  ) {
    throw new Error(`[json-repo] invalid fileName: "${fileName}". Must be a plain .json filename without path separators.`);
  }
  const filePath = path.resolve(__dirname, '../../../data', fileName);

  const audit = (action, detail) => {
    if (!onAccess) return;
    try { onAccess(action, detail); } catch (e) { /* 監査失敗はサイレント */ }
  };

  // ファイル内容の stat 指紋キャッシュ。
  // リクエスト毎に複数の getById/getAll が走るが、書き込みは全て atomicWriteJSON の
  // temp+rename 経由なので mtime/size の指紋で他プロセス更新も確実に検出できる。
  // 返却値は必ず複製する: 呼び出し側が取得レコードを書き換えても（update の
  // rows[idx] 代入、finder 結果のフィールド改変など）キャッシュ本体を汚さないため。
  let _cache = null;
  let _cacheStamp = null;

  function fileStamp() {
    try {
      const s = fs.statSync(filePath);
      return `${s.mtimeMs}:${s.size}`;
    } catch (_) {
      // ファイル不在・stat 失敗時はキャッシュを使わない（毎回実読み）
      return null;
    }
  }

  function readFromDisk() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      // 読み取り I/O 失敗はそのまま伝播（権限・FD 枯渇等を握り潰さない）
      throw new Error(`[json-repo] failed to read ${fileName}: ${e.message}`);
    }
    try {
      const parsed = JSON.parse(raw);
      // トップレベルは配列が契約。破損して object 等になった場合も fail-closed。
      if (!Array.isArray(parsed)) {
        throw new Error('parsed JSON is not an array');
      }
      return parsed;
    } catch (e) {
      // 旧実装はパース失敗時にサイレントで [] を返していた。これは致命的:
      // 後続の create/update が「空配列 + 1 行」で既存ファイルを atomicWrite し、
      // 一時的・回復可能な破損を「不可逆なデータ全消失」へ変換してしまう
      // （escrows.json / payments.json で資金記録が消える）。
      // fail-closed: 破損ファイルは温存（rename しない＝次回 load が [] を返して
      // 上書きするのを防ぐ）し、明示的に throw して運用者に検知させる。
      throw new Error(
        `[json-repo] ${fileName} is corrupt and could not be parsed (${e.message}). ` +
        `Refusing to read to avoid overwriting recoverable data. ` +
        `Inspect/restore ${filePath} (or a backup) and retry.`
      );
    }
  }

  function load() {
    // stat を read より先に取る: 読み取り中に別プロセスが rename した場合、
    // 記録する指紋は実内容より古い側に倒れ、次回 load が再読みする（保守側）。
    const stamp = fileStamp();
    if (_cache !== null && stamp !== null && stamp === _cacheStamp) {
      return structuredClone(_cache);
    }
    if (!fs.existsSync(filePath)) {
      // 不在ファイルはキャッシュしない（作成直後の stat を必ず通すため）
      _cache = null;
      _cacheStamp = null;
      return [];
    }
    const rows = readFromDisk();
    if (stamp !== null) {
      _cache = rows;
      _cacheStamp = stamp;
    } else {
      _cache = null;
      _cacheStamp = null;
    }
    return structuredClone(rows);
  }

  const repo = {
    getAll: () => {
      const rows = load();
      audit('getAll', { count: rows.length });
      return rows;
    },
    getById: (id) => {
      const row = load().find((r) => r.id === id) || null;
      audit('getById', { id, found: !!row });
      return row;
    },
    create: (rec) => {
      const rows = load();
      const safeRec = stripDangerousKeys(rec);
      const row = { ...safeRec, id: uuidv4(), createdAt: (rec && rec.createdAt) || new Date().toISOString() };
      rows.push(row);
      atomicWriteJSON(filePath, rows);
      audit('create', { id: row.id });
      return row;
    },
    update: (id, updates) => {
      const rows = load();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) {
        audit('update', { id, result: 'not_found' });
        return null;
      }
      rows[idx] = { ...rows[idx], ...stripDangerousKeys(updates) };
      atomicWriteJSON(filePath, rows);
      audit('update', { id, updates });
      return rows[idx];
    },
    // Atomic compare-and-swap: loads, checks predicate, and writes in one synchronous
    // section (no await between load and write), preventing TOCTOU race conditions.
    // Returns { ok: true, row } on success or { ok: false, reason, current } on failure.
    updateIf: (id, predicate, updates) => {
      const rows = load();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx === -1) {
        audit('updateIf', { id, result: 'not_found' });
        return { ok: false, reason: 'not_found' };
      }
      if (!predicate(rows[idx])) {
        audit('updateIf', { id, result: 'condition_failed' });
        return { ok: false, reason: 'condition_failed', current: rows[idx] };
      }
      rows[idx] = { ...rows[idx], ...stripDangerousKeys(updates) };
      atomicWriteJSON(filePath, rows);
      audit('updateIf', { id, updates });
      return { ok: true, row: rows[idx] };
    },
    delete: (id) => {
      const rows = load();
      const remaining = rows.filter((r) => r.id !== id);
      const deleted = remaining.length < rows.length;
      atomicWriteJSON(filePath, remaining);
      audit('delete', { id, deleted });
      return deleted;
    },
  };

  for (const [name, spec] of Object.entries(finders)) {
    const { field, many = false } = spec;
    repo[name] = (value) => {
      if (many) {
        const rows = load().filter((r) => r[field] === value);
        audit(name, { [field]: value, count: rows.length });
        return rows;
      }
      const row = load().find((r) => r[field] === value) || null;
      audit(name, { [field]: value, found: !!row });
      return row;
    };
  }

  return repo;
}

module.exports = { createJsonRepository, stripDangerousKeys };
