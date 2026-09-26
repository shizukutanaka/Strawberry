// p2p-notify.js - 死活監視・異常自動通知の多チャネル＆多監視対象自動化
// ./p2p-health は libp2p 系（未導入環境では require 失敗）に依存するため、
// 外部ターゲット監視だけを使う用途でモジュール自体が読み込めるよう遅延 require。
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
// 既定値は公開 liveness の /health。/api/system/info は admin 専用で、既定のままだと
// 認証なしポーリングが常に 401 を受けて「API_DOWN」アラートを誤発報し続ける。
const MONITOR_TARGETS = (process.env.MONITOR_TARGETS || 'http://localhost:3000/health').split(',');

function logAudit(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ...event, time: new Date().toISOString() }) + '\n');
  } catch (e) {}
}

// 監視対象ごとの直近状態。通知は状態遷移時のみ（up→down で1回、down→up で復帰1回）。
// 15 秒ポーリングで連続ダウン中に毎回通知するとチャネルがスパム化するため。
const _targetState = new Map();

async function _notifyOnTransition(key, isDown, downMsg) {
  const prev = _targetState.get(key) || 'up';
  const next = isDown ? 'down' : 'up';
  if (prev === next) return;
  _targetState.set(key, next);
  if (isDown) await notifyAll(downMsg, 'DOWN');
  else await notifyAll(`【復帰】${key} が正常応答に復帰しました`, 'RECOVERY');
}

async function checkHealthFile() {
  if (!fs.existsSync(HEALTH_FILE)) return;
  let health;
  try {
    health = JSON.parse(fs.readFileSync(HEALTH_FILE));
  } catch (_) {
    return;
  }
  const down = health.peerCount === 0;
  const downMsg = `【P2Pノード障害検知】\nピア接続がありません（${health.peerId}）\n${new Date(health.timestamp).toLocaleString()}`;
  await _notifyOnTransition('p2p-node', down, downMsg);
}

async function checkExternalTargets() {
  for (const url of MONITOR_TARGETS) {
    try {
      const res = await axios.get(url, { timeout: 7000 });
      await _notifyOnTransition(url, res.status !== 200, `【API死活監視】${url} が異常応答: ${res.status}`);
    } catch (e) {
      await _notifyOnTransition(url, true, `【API死活監視】${url} にアクセスできません: ${e.message}`);
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

function startNotifyLoop() {
  setInterval(() => { checkHealthFile(); checkExternalTargets(); }, 15000); // 15秒ごとに全監視
}

if (require.main === module) {
  require('./p2p-health').main(); // libp2p 依存はここでのみ
  startNotifyLoop();
}

// テスト用: 状態遷移キャッシュのリセット。
function _resetTargetState() { _targetState.clear(); }

module.exports = {
  startNotifyLoop,
  checkHealthFile,
  checkExternalTargets,
  notifyAll,
  _resetTargetState,
};
