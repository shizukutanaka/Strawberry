// p2p-notify.js - 死活監視・異常自動通知の多チャネル＆多監視対象自動化
const { main: healthMain } = require('./p2p-health');
const { sendNotification, NotifyType } = require('./utils/notifier');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HEALTH_FILE = path.join(__dirname, 'health.json');
// 死活監視アラートの記録先。改ざん検知ハッシュチェーンが管理する logs/audit.log とは
// 分離する（混在させると verifyAuditLogIntegrity / audit-anchor が常に失敗する）。
const LOG_PATH = process.env.MONITOR_LOG_PATH || path.join(__dirname, '../logs/monitor-audit.log');

// 通知先（環境変数で柔軟に切替）
const CHANNELS = [
  process.env.LINE_TOKEN ? { type: NotifyType.LINE, opts: { token: process.env.LINE_TOKEN } } : null,
  process.env.DISCORD_WEBHOOK ? { type: NotifyType.DISCORD, opts: { webhookUrl: process.env.DISCORD_WEBHOOK } } : null,
  process.env.SLACK_WEBHOOK ? { type: NotifyType.SLACK, opts: { webhookUrl: process.env.SLACK_WEBHOOK } } : null,
  process.env.GENERIC_WEBHOOK ? { type: NotifyType.WEBHOOK, opts: { webhookUrl: process.env.GENERIC_WEBHOOK } } : null,
  process.env.EMAIL_TO ? { type: NotifyType.EMAIL, opts: { to: process.env.EMAIL_TO, subject: '【Strawberry】死活監視アラート' } } : null
].filter(Boolean);

// 監視対象API/外部サービス
const MONITOR_TARGETS = (process.env.MONITOR_TARGETS || 'http://localhost:3000/api/system/info').split(',');

function logAudit(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n');
  } catch (e) {}
}

// health.json は p2p-health が 10 秒ごとに書き込む。更新が止まった場合は
// ピア切断ではなく「ノード/監視プロセス自体の停止」なのでアラートを分ける。
const HEALTH_STALE_MS = 60 * 1000;

async function checkHealthFile() {
  if (!fs.existsSync(HEALTH_FILE)) return;
  let health;
  try {
    health = JSON.parse(fs.readFileSync(HEALTH_FILE));
  } catch (_) {
    return;
  }
  const ts = new Date(health.timestamp || 0).getTime();
  if (!Number.isFinite(ts) || Date.now() - ts > HEALTH_STALE_MS) {
    const last = Number.isFinite(ts) ? new Date(ts).toLocaleString() : 'unknown';
    await notifyAll(`【P2Pノード障害検知】\n死活監視データが更新されていません（最終: ${last}）。ノードまたは監視プロセスが停止している可能性`, 'NODE_MONITOR_STALE');
  } else if (health.peerCount === 0) {
    const msg = `【P2Pノード障害検知】\nピア接続がありません（${health.peerId}）\n${new Date(health.timestamp).toLocaleString()}`;
    await notifyAll(msg, 'NODE_DOWN');
  }
}

async function checkExternalTargets() {
  for (const url of MONITOR_TARGETS) {
    try {
      const res = await axios.get(url, { timeout: 7000 });
      if (res.status !== 200) {
        await notifyAll(`【API死活監視】${url} が異常応答: ${res.status}`, 'API_DOWN');
      }
    } catch (e) {
      await notifyAll(`【API死活監視】${url} にアクセスできません: ${e.message}`, 'API_DOWN');
    }
  }
}

async function notifyAll(msg, type = 'ALERT') {
  for (const ch of CHANNELS) {
    try {
      await sendNotification(ch.type, msg, ch.opts);
    } catch (e) {
      // 通知失敗も監査ログ
      logAudit({ type: 'NOTIFY_FAIL', channel: ch.type, message: msg, error: e.message });
    }
  }
  logAudit({ type, message: msg });
}

// 非同期チェックの多重起動を防ぐ単一フライトガード。
// checkExternalTargets は対象ごとに最大 7s の axios timeout を持ち、
// MONITOR_TARGETS が複数あると 1 tick が 15s を超え得る。そのままだと
// 前の tick が生きている間に次の tick が走り、障害中はアラートが二重化する。
let tickRunning = false;
function startNotifyLoop(intervalMs = 15000) {
  setInterval(async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await checkHealthFile();
      await checkExternalTargets();
    } catch (e) {
      logAudit({ type: 'TICK_ERROR', error: e.message });
    } finally {
      tickRunning = false;
    }
  }, intervalMs);
}

if (require.main === module) {
  // P2P ヘルス監視は libp2p 導入環境でのみ有効。未導入でも外部 API 監視
  // （MONITOR_TARGETS）は単独で動作させる（README 記載の運用コマンド）。
  Promise.resolve()
    .then(() => healthMain())
    .catch(e => console.warn(`P2P ヘルス監視をスキップします: ${e.message}`));
  startNotifyLoop();
}

module.exports = {
  startNotifyLoop,
  checkHealthFile,
  checkExternalTargets,
  notifyAll,
};
