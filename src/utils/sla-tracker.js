// SLA（稼働率保証）自動集計・表示ユーティリティ
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const { logger } = require('./logger');
const { resilientNotify } = require('./resilient-notify');

const SLA_PATH = path.join(__dirname, '../../data/sla.json');
const CHECK_INTERVAL = 60 * 1000; // 1分
const HEALTH_TIMEOUT_MS = 5_000; // /health 応答待ちの上限

let _timer = null;
let _running = false; // updateSLA の重複実行防止（load→save の RMW 競合回避）

function loadSLA() {
  if (!fs.existsSync(SLA_PATH)) return { total: 0, up: 0, down: 0, history: [] };
  try {
    return JSON.parse(fs.readFileSync(SLA_PATH, 'utf-8'));
  } catch (_) {
    return { total: 0, up: 0, down: 0, history: [] };
  }
}
function saveSLA(sla) {
  atomicWriteJSON(SLA_PATH, sla);
}

async function checkAlive() {
  // HTTP/DB/主要プロセス等の死活監視（server.js の /health を参照）
  // fetch にタイムアウトが無いと応答しないサーバーで updateSLA が永遠に滞留し、
  // 以後の周期が全て再入ガードで空回りする。
  try {
    const port = process.env.PORT || 3000;
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function updateSLA() {
  // 重複実行防止: checkAlive が滞留したまま次の周期が走ると、
  // load→save の read-modify-write が競合してカウンタを相殺し合う。
  if (_running) return;
  _running = true;
  try {
    const sla = loadSLA();
    sla.total++;
    const alive = await checkAlive();
    if (alive) sla.up++;
    else sla.down++;
    sla.history.push({ time: new Date().toISOString(), alive });
    if (sla.history.length > 1440) sla.history.shift(); // 1日分だけ保持
    saveSLA(sla);
    if (!alive) {
      logger.warn('[SLA] 死活監視NG');
      // 通知経路未設定/全失敗でも集計ループを止めない
      try {
        await resilientNotify('[Strawberry] 死活監視NG: サービスが応答しません');
      } catch (e) {
        logger.warn(`[SLA] 通知失敗: ${e.message}`);
      }
    }
  } finally {
    _running = false;
  }
}

function getSLAStats() {
  const sla = loadSLA();
  const rate = sla.total ? (sla.up / sla.total) : 1;
  return { uptimeRate: rate, up: sla.up, total: sla.total, down: sla.down };
}

function startSLATracker() {
  if (_timer) return;
  // テスト環境でのタイマー抑止は invoice-poller / service-monitor と同じ方針。
  // Jest はテストファイルごとにモジュールを再ロードするため、ここで周期
  // タイマーを張ると実タイマーが各スイートで残存しイベントループを圧迫する。
  if (process.env.NODE_ENV === 'test') return;
  _timer = setInterval(() => {
    updateSLA().catch((e) => logger.warn(`[SLA] updateSLA failed: ${e.message}`));
  }, CHECK_INTERVAL);
  if (_timer.unref) _timer.unref(); // タイマーがプロセス終了を妨げないように
}

function stopSLATracker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { startSLATracker, stopSLATracker, getSLAStats, updateSLA };
