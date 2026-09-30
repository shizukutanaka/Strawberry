// 新着フィードバックをSlackに即時通知するBot（feedback-bot.jsから利用可能）
const https = require('https');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // .envに設定

// Slack エンドポイントが応答しなくなった場合に呼出プロセスが永久滞留しないよう
// 明示的タイムアウトを付与する（outbound 呼出のタイムアウト方針と同型）。
// ops スクリプト共有経路（gpu-failure-monitor / alert-* 等）のため env で調整可能にする。
const _timeoutEnv = parseInt(process.env.SLACK_WEBHOOK_TIMEOUT_MS || '', 10);
const WEBHOOK_TIMEOUT_MS = Number.isFinite(_timeoutEnv) && _timeoutEnv > 0 ? _timeoutEnv : 10000;

function sendSlackMessage(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('[slack-feedback-bot] SLACK_WEBHOOK_URL未設定のため通知をスキップします');
    return;
  }
  const data = JSON.stringify({ text });
  // URL パース失敗や非 https 指定で例外を呼出側へ投げない
  // （監視スクリプトの例外で cron プロセスを落とさない）。
  let url;
  try {
    url = new URL(SLACK_WEBHOOK_URL);
  } catch (e) {
    console.error('[slack-feedback-bot] SLACK_WEBHOOK_URL が不正です:', e.message);
    return;
  }
  if (url.protocol !== 'https:') {
    console.error('[slack-feedback-bot] SLACK_WEBHOOK_URL は https:// で始まる必要があります');
    return;
  }
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  const req = https.request(options, res => {
    res.resume(); // レスポンス本文を読んでソケットを解放
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.error('Slack通知失敗:', res.statusCode);
    }
  });
  req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
    req.destroy(new Error(`Slack webhook request timed out after ${WEBHOOK_TIMEOUT_MS}ms`));
  });
  req.on('error', err => console.error('Slack通知エラー:', err));
  req.write(data);
  req.end();
}

module.exports = { sendSlackMessage };
