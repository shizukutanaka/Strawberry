// 不正利用・異常検知自動化ユーティリティ
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');

const ANOMALY_LOG_PATH = path.join(__dirname, '../../logs/anomaly.log');
const ANOMALY_HISTORY_PATH = path.join(__dirname, '../../logs/anomaly-history.json');

/**
 * 異常イベントを記録・通知・監査
 * @param {string} type
 * @param {object} detail
 */
function reportAnomaly(type, detail = {}) {
  const entry = { time: new Date().toISOString(), type, detail };
  fs.appendFileSync(ANOMALY_LOG_PATH, JSON.stringify(entry) + '\n');
  let history = [];
  if (fs.existsSync(ANOMALY_HISTORY_PATH)) {
    history = JSON.parse(fs.readFileSync(ANOMALY_HISTORY_PATH, 'utf-8'));
  }
  history.push(entry);
  if (history.length > 1000) history.shift();
  fs.writeFileSync(ANOMALY_HISTORY_PATH, JSON.stringify(history, null, 2));
  logger.warn('[Anomaly] 異常検知', entry);
  resilientNotify(`[Strawberry] 異常検知: ${type}\n${JSON.stringify(detail)}`).catch(()=>{});
  appendAuditLog('anomaly_detected', { type, detail });
}

/**
 * 不正アクセス・異常利用パターン検知例
 * @param {object} req - Expressリクエスト
 */
function detectRequestAnomaly(req) {
  // 例: 1分間に同一IPから100回以上アクセス
  const ip = req.ip;
  const now = Date.now();
  if (!global.__anomaly_ip_counter) global.__anomaly_ip_counter = {};
  const counter = global.__anomaly_ip_counter;
  counter[ip] = counter[ip] || [];
  counter[ip].push(now);
  // 直近1分だけ残す
  counter[ip] = counter[ip].filter(ts => now - ts < 60000);
  if (counter[ip].length > 100) {
    reportAnomaly('too_many_requests', { ip, count: counter[ip].length });
    return true;
  }
  return false;
}

module.exports = { reportAnomaly, detectRequestAnomaly };
