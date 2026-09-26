// src/security/ots-submitter.js
// 監査アンカー（Merkle root）の OpenTimestamps 提出（docs/improvement-research-2026 §18）。
// audit-anchor.js が audit.log エントリを Merkle 木に集約して root を作るまでを担い、
// 本モジュールはその root（= 32B digest）を公開カレンダーへ提出して receipts を
// logs/ots-receipts.jsonl に記録し、後日の upgrade（Bitcoin 確定確認）を面倒見る。
//
// OTS カレンダー API:
//   POST {calendar}/digest          body=32B digest → 保留中 Timestamp（receipt）
//   GET  {calendar}/timestamp/{hex} → Bitcoin attestation 済み proof（確定後）
// root をそのまま digest として提出するため、第三者は「時点 T に root R のログ状態が
// 存在した」ことを OTS 経由で検証できる（= 運営による遡及改ざんの否認）。
//
// 設計は invoice-poller / ln-adapter と同型: アダプタ差し替え（HTTP 実機 / Mock）、
// 外部依存の失敗は絶対に上位へ投げず、per-calendar の receipts に記録する。
const fs = require('fs');
const path = require('path');
const { anchorNewEntries, readAnchors } = require('./audit-anchor');
const { logger } = require('../utils/logger');

const OTS_RECEIPTS_PATH = path.join(__dirname, '../../logs/ots-receipts.jsonl');

// 公開 OpenTimestamps カレンダー（冗長化のため複数へ並行提出）
const DEFAULT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

/** アンカーの Merkle root（sha256 hex）を OTS digest として取り出す。 */
function digestOfAnchor(anchor) {
  const hex = anchor && anchor.root;
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) throw new Error('anchor.root must be a sha256 hex');
  return hex.toLowerCase();
}

/**
 * 実カレンダーへの HTTP アダプタ。axios は既存依存。
 * submit は digest の生バイトを POST し、応答（保留中 Timestamp シリアライズ）を
 * base64 で返す。fetchAttestation は GET /timestamp/<hex> の結果、確定前や
 * 404/空なら null を返す。
 */
function createHttpOtsAdapter({ timeoutMs = 10000, axiosImpl } = {}) {
  const axios = axiosImpl || require('axios');
  return {
    name: 'http',
    async submit(digestHex, calendarUrl) {
      const res = await axios.post(`${calendarUrl}/digest`, Buffer.from(digestHex, 'hex'), {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.data || res.data.byteLength === 0) throw new Error('empty receipt');
      return Buffer.from(res.data).toString('base64');
    },
    async fetchAttestation(digestHex, calendarUrl) {
      const res = await axios.get(`${calendarUrl}/timestamp/${digestHex}`, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        validateStatus: () => true, // 404 = 未確定として扱うため例外化しない
      });
      if (res.status !== 200 || !res.data || res.data.byteLength === 0) return null;
      return Buffer.from(res.data).toString('base64');
    },
  };
}

/**
 * テスト/開発用 Mock。submit は決定論的レシートを即時発行し、
 * fetchAttestation は confirmAfterMs 経過後にのみ attestation を返す
 * （確定待ち → 確定の遷移を再現する）。
 */
function createMockOtsAdapter({ confirmAfterMs = 0 } = {}) {
  const submittedAt = new Map();
  return {
    name: 'mock',
    async submit(digestHex) {
      if (!submittedAt.has(digestHex)) submittedAt.set(digestHex, Date.now());
      return Buffer.from(`mock-ots-receipt:${digestHex}`).toString('base64');
    },
    async fetchAttestation(digestHex) {
      const t = submittedAt.get(digestHex);
      if (t === undefined || Date.now() - t < confirmAfterMs) return null;
      return Buffer.from(`mock-attestation:${digestHex}`).toString('base64');
    },
  };
}

/**
 * 実行時のアダプタ選択。NODE_ENV=test または OTS_ADAPTER=mock → Mock。
 * OTS_ENABLED=false → null（アンカー生成のみ・外部提出しない）。
 */
function pickAdapter(env = process.env) {
  if (env.OTS_ENABLED === 'false') return null;
  if (env.NODE_ENV === 'test' || env.OTS_ADAPTER === 'mock') return createMockOtsAdapter();
  return createHttpOtsAdapter();
}

/**
 * 1 アンカーを全カレンダーへ提出。外部失敗は投げずに per-calendar 記録へ畳み込む。
 * @returns {{anchorRoot,digest,submittedAt,status:'pending'|'failed',calendars:[{url,receipt?}|{url,error}]}}
 *   pending = 少なくとも 1 カレンダーが受理（Bitcoin 確定待ち）
 */
async function submitAnchor(anchor, { adapter, calendars = DEFAULT_CALENDARS, now = () => new Date().toISOString() } = {}) {
  const digest = digestOfAnchor(anchor);
  const record = {
    anchorRoot: anchor.root,
    digest,
    submittedAt: now(),
    status: 'failed',
    calendars: [],
  };
  if (!adapter) {
    record.status = 'disabled';
    return record;
  }
  for (const url of calendars) {
    try {
      const receipt = await adapter.submit(digest, url);
      record.calendars.push({ url, receipt });
    } catch (e) {
      record.calendars.push({ url, error: e.message || String(e) });
    }
  }
  if (record.calendars.some((c) => c.receipt)) record.status = 'pending';
  return record;
}

/** receipts JSONL を読み出す（壊れた行はスキップ）。 */
function readReceipts(otsPath = OTS_RECEIPTS_PATH) {
  if (!fs.existsSync(otsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(otsPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (_) { /* 部分書込み行は無視 */ }
  }
  return out;
}

function writeReceipts(records, otsPath = OTS_RECEIPTS_PATH) {
  fs.mkdirSync(path.dirname(otsPath), { recursive: true });
  fs.writeFileSync(otsPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

/**
 * 監査ログの新規エントリを増分アンカーし、root を OTS へ提出して receipt を追記する。
 * @returns {{anchor, receipt}|{skipped:true}|null}
 */
async function anchorAndSubmit({ logPath, anchorPath, otsPath = OTS_RECEIPTS_PATH, adapter, calendars, now } = {}) {
  const anchor = anchorNewEntries({ logPath, anchorPath, now });
  if (!anchor) return null;
  const effectiveAdapter = adapter === undefined ? pickAdapter() : adapter;
  const receipt = await submitAnchor(anchor, { adapter: effectiveAdapter, calendars, now });
  appendReceipt(otsPath, receipt);
  return { anchor, receipt };
}

function appendReceipt(otsPath, record) {
  fs.mkdirSync(path.dirname(otsPath), { recursive: true });
  fs.appendFileSync(otsPath, JSON.stringify(record) + '\n');
}

/**
 * pending receipts をカレンダーへ照合し、attestation が得られたものを confirmed に更新。
 * JSONL を全件読み → 更新 → 書き戻し（小さい台帳前提の単純実装）。
 * @returns {{checked:number, confirmed:number}}
 */
async function upgradePending({ adapter, otsPath = OTS_RECEIPTS_PATH, now = () => new Date().toISOString() } = {}) {
  const records = readReceipts(otsPath);
  if (records.length === 0) return { checked: 0, confirmed: 0 };
  const effectiveAdapter = adapter === undefined ? pickAdapter() : adapter;
  if (!effectiveAdapter) return { checked: 0, confirmed: 0 };

  let confirmed = 0;
  for (const r of records) {
    if (r.status !== 'pending') continue;
    for (const cal of r.calendars) {
      if (!cal.receipt || cal.attestation) continue;
      try {
        const attestation = await effectiveAdapter.fetchAttestation(r.digest, cal.url);
        if (attestation) {
          cal.attestation = attestation;
          cal.attestedAt = now();
          r.status = 'confirmed';
          r.confirmedAt = now();
          confirmed += 1;
          break; // 1 カレンダーで確定すれば十分（他は冗長 receipt として残す）
        }
      } catch (e) {
        cal.error = e.message || String(e);
      }
    }
  }
  writeReceipts(records, otsPath);
  return { checked: records.filter((r) => r.status === 'pending' || r.status === 'confirmed').length, confirmed };
}

/** 監視向けサマリ。 */
function getOtsStatus(otsPath = OTS_RECEIPTS_PATH) {
  const receipts = readReceipts(otsPath);
  const byStatus = {};
  for (const r of receipts) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    total: receipts.length,
    ...byStatus,
    latest: receipts.length ? receipts[receipts.length - 1] : null,
  };
}

module.exports = {
  submitAnchor,
  anchorAndSubmit,
  upgradePending,
  readReceipts,
  getOtsStatus,
  digestOfAnchor,
  pickAdapter,
  createHttpOtsAdapter,
  createMockOtsAdapter,
  DEFAULT_CALENDARS,
  OTS_RECEIPTS_PATH,
};
