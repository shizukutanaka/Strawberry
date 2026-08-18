// src/utils/external-alerts.js
// 障害・重要イベントを外部チャネル（Slack / LINE / Sentry）へ通知する。
//
// ── なぜ書き直したか ──────────────────────────────────────────────────────
// 通知は `scripts/` に CLI として置かれ、`src/core/service-monitor.js` から
// ライブラリとして require されていた。その結果 3 チャネルのうち 2 つが
// **一度も送信できていなかった**:
//
//  * Slack: service-monitor は `require('scripts/slack-notify.js').sendSlackMessage`
//    を呼んでいたが、あのモジュールが export していたのは `notifyReport` だけ。
//    毎回 undefined を呼んで例外になり、catch されて warn ログに消えていた。
//    さらに実体の sendSlackMessage は webhook 未設定時に **process.exit(1)** する。
//    export されていたら、env の設定漏れで API サーバごと落ちていた
//    （export 漏れが偶然サーバを守っていた）。
//  * Sentry: `@sentry/node` は依存に入っていない。require の時点で失敗する。
//
// 運営は SLACK_WEBHOOK_URL を設定して「障害時に通知が来る」と思っている。
// 実際には来ない。**死んでいる通知経路は、通知経路が無いより悪い**
// （来ないことを異常だと気づけない）。
//
// ── 方針 ──────────────────────────────────────────────────────────────────
//  * 長時間走るサーバから呼ばれる前提。**process.exit しない**。
//  * 送信結果を Promise で返す（呼び出し側が await して結果を判定できる）。
//  * 未設定のチャネルは `{ sent: false, reason: 'not_configured' }` を返すだけ。
//    設定されているのに送れなかった場合だけ失敗として扱う。
//  * 送信失敗で呼び出し元の処理を壊さない（通知は本処理の付随物）。
const https = require('https');

const SLACK_TIMEOUT_MS = 5000;

/** 設定済みのチャネル名を返す（診断・起動ログ用）。 */
function configuredChannels() {
  const out = [];
  if (process.env.SLACK_WEBHOOK_URL) out.push('slack');
  if (process.env.LINE_TOKEN) out.push('line');
  if (process.env.SENTRY_DSN) out.push('sentry');
  return out;
}

/**
 * Slack Incoming Webhook へ送る。
 * @returns {Promise<{sent:boolean, reason?:string, statusCode?:number}>}
 */
function sendSlackMessage(text) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return Promise.resolve({ sent: false, reason: 'not_configured' });

  let url;
  try {
    url = new URL(webhook);
  } catch (e) {
    return Promise.resolve({ sent: false, reason: 'invalid_webhook_url' });
  }
  if (url.protocol !== 'https:') {
    // webhook URL には秘密が含まれる。平文で投げない。
    return Promise.resolve({ sent: false, reason: 'insecure_webhook_url' });
  }

  const body = JSON.stringify({ text: String(text) });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: SLACK_TIMEOUT_MS,
    }, (res) => {
      // 本文は読み捨てるが、読まないとソケットが解放されない。
      res.resume();
      resolve(res.statusCode === 200
        ? { sent: true, statusCode: res.statusCode }
        : { sent: false, reason: 'http_error', statusCode: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ sent: false, reason: 'timeout' }); });
    req.on('error', (err) => resolve({ sent: false, reason: `request_error: ${err.message}` }));
    req.write(body);
    req.end();
  });
}

/** LINE Notify へ送る。 */
async function sendLineNotification(event, data) {
  if (!process.env.LINE_TOKEN) return { sent: false, reason: 'not_configured' };
  try {
    const axios = require('axios');
    await axios.post(
      'https://notify-api.line.me/api/notify',
      `message=[${event}] ${JSON.stringify(data)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${process.env.LINE_TOKEN}`,
        },
        timeout: SLACK_TIMEOUT_MS,
      },
    );
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `request_error: ${e.message}` };
  }
}

/**
 * Sentry へ送る。@sentry/node は任意依存で、未導入なら送らない。
 * **未導入なのに DSN が設定されている**場合は理由を返す — 運営は通知が来ると
 * 思っているので、黙って捨てるのが一番まずい。
 */
let _sentry = null;
let _sentryLoadFailed = false;
function _loadSentry() {
  if (_sentry || _sentryLoadFailed) return _sentry;
  try {
    _sentry = require('@sentry/node');
    _sentry.init({ dsn: process.env.SENTRY_DSN });
  } catch (e) {
    _sentryLoadFailed = true;
    _sentry = null;
  }
  return _sentry;
}

async function sendSentryNotification(event, data) {
  if (!process.env.SENTRY_DSN) return { sent: false, reason: 'not_configured' };
  const Sentry = _loadSentry();
  if (!Sentry) return { sent: false, reason: 'sentry_sdk_not_installed' };
  try {
    Sentry.captureMessage(`[${event}] ${JSON.stringify(data)}`);
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: `capture_error: ${e.message}` };
  }
}

/**
 * 設定済みの全チャネルへ通知する。
 * @returns {Promise<Array<{channel:string, sent:boolean, reason?:string}>>}
 */
async function notifyAll(event, data) {
  const results = [];
  if (process.env.SLACK_WEBHOOK_URL) {
    results.push({ channel: 'slack', ...(await sendSlackMessage(`[${event}] ${JSON.stringify(data)}`)) });
  }
  if (process.env.SENTRY_DSN) {
    results.push({ channel: 'sentry', ...(await sendSentryNotification(event, data)) });
  }
  if (process.env.LINE_TOKEN) {
    results.push({ channel: 'line', ...(await sendLineNotification(event, data)) });
  }
  return results;
}

module.exports = {
  sendSlackMessage,
  sendLineNotification,
  sendSentryNotification,
  notifyAll,
  configuredChannels,
  _resetSentryForTest: () => { _sentry = null; _sentryLoadFailed = false; },
};
