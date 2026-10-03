// 不正利用・異常検知自動化ユーティリティ
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { withLock } = require('./async-lock');
const { logger } = require('./logger');
const { appendRotated } = require('./log-rotate');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');

const ANOMALY_LOG_PATH = path.join(__dirname, '../../logs/anomaly.log');
const ANOMALY_HISTORY_PATH = path.join(__dirname, '../../logs/anomaly-history.json');

// logs/ は .gitignore 済みのため新規 clone/デプロイでは存在しない。
// mkdir しない appendFileSync は ENOENT を投げ、異常イベントの報告自体が
// 呼び出し元（gpu-monitor 等）をクラッシュさせる。
function ensureLogDir() {
  fs.mkdirSync(path.dirname(ANOMALY_LOG_PATH), { recursive: true });
}

/**
 * 異常イベントを記録・通知・監査
 * @param {string} type
 * @param {object} detail
 */
function reportAnomaly(type, detail = {}) {
  const entry = { time: new Date().toISOString(), type, detail };
  // appendFileSync は O_APPEND でアトミック（Linux カーネル保証）なので lock 不要。
  // ログ書き込み失敗（ディスクフル等）が報告呼び出しを殺さないようガードする。
  try {
    ensureLogDir();
    appendRotated(ANOMALY_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    logger.warn(`[Anomaly] failed to append anomaly.log: ${e.message}`);
  }
  // 履歴 JSON は読み込み→追加→書き込みのシーケンスが非アトミックなため、
  // 並行呼び出しで「後勝ち」上書きが発生して異常イベントが消えるリスクがある。
  // per-key withLock でシリアライズして履歴の完全性を保証する。
  withLock('anomaly-history', async () => {
    ensureLogDir();
    let history = [];
    if (fs.existsSync(ANOMALY_HISTORY_PATH)) {
      try {
        history = JSON.parse(fs.readFileSync(ANOMALY_HISTORY_PATH, 'utf-8'));
      } catch (_) {
        history = [];
      }
    }
    history.push(entry);
    if (history.length > 1000) history.shift();
    atomicWriteJSON(ANOMALY_HISTORY_PATH, history);
  }).catch((e) => logger.warn(`[Anomaly] failed to persist anomaly-history: ${e.message}`));
  logger.warn('[Anomaly] 異常検知', entry);
  resilientNotify(`[Strawberry] 異常検知: ${type}\n${JSON.stringify(detail)}`).catch(()=>{});
  appendAuditLog('anomaly_detected', { type, detail });
}

// 直近1分のリクエストタイムスタンプを IP 毎に保持する。
// Object.create(null): キー名に依存しない安全な辞書（__proto__ 等の特殊キー混入防止）。
const ANOMALY_WINDOW_MS = 60 * 1000;
const ANOMALY_IP_THRESHOLD = 100;
// 上限: ユニーク IP がこの数を超えたら期限切れエントリを全消去する。
// 単純な size 上限だけにすると攻撃者がユニーク IP を回すだけで正規ユーザーの
// カウンタを追い出せるため、TTL 掃除を優先する。
const ANOMALY_IP_MAX_KEYS = 10_000;
const ipRequestTimestamps = new Map(); // ip -> number[]

function sweepIpCounter(now) {
  for (const [ip, stamps] of ipRequestTimestamps) {
    const fresh = stamps.filter((ts) => now - ts < ANOMALY_WINDOW_MS);
    if (fresh.length === 0) ipRequestTimestamps.delete(ip);
    else ipRequestTimestamps.set(ip, fresh);
  }
}

/**
 * 不正アクセス・異常利用パターン検知例
 * @param {object} req - Expressリクエスト
 */
function detectRequestAnomaly(req) {
  // 例: 1分間に同一IPから100回以上アクセス
  const ip = String((req && req.ip) || 'unknown');
  const now = Date.now();
  // Map 上限を超えたら全件スイープ（古い IP が永久残留する無制限増殖を防ぐ）。
  // スイープ後も溢れる場合は最古のキーから捨てる（Map は挿入順を保持）。
  if (ipRequestTimestamps.size > ANOMALY_IP_MAX_KEYS) {
    sweepIpCounter(now);
    while (ipRequestTimestamps.size > ANOMALY_IP_MAX_KEYS) {
      const oldest = ipRequestTimestamps.keys().next().value;
      ipRequestTimestamps.delete(oldest);
    }
  }
  const stamps = ipRequestTimestamps.get(ip) || [];
  stamps.push(now);
  // 窓外のタイムスタンプをここで削る（エントリ単位の肥大化を防止）。
  const fresh = stamps.filter((ts) => now - ts < ANOMALY_WINDOW_MS);
  ipRequestTimestamps.set(ip, fresh);
  if (fresh.length > ANOMALY_IP_THRESHOLD) {
    reportAnomaly('too_many_requests', { ip, count: fresh.length });
    return true;
  }
  return false;
}

module.exports = { reportAnomaly, detectRequestAnomaly, _ipRequestTimestamps: ipRequestTimestamps };
