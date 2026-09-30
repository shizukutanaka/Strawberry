// scripts/sentry-notify.js
// Sentry通知モジュール（DSNは環境変数SENTRY_DSNで指定）
// @sentry/node は任意依存（package.json 未宣言・意図的に optional。
// tests/scripts/script-deps.test.js の INTENTIONALLY_OPTIONAL 参照）。
// トップレベルで require すると、SENTRY_DSN を設定した環境で
// service-monitor.js の遅延 require が MODULE_NOT_FOUND で失敗し、
// アラート毎に警告が出て Sentry へ届かない。実際に使う時だけ解決し、
// 未導入なら導入手順の分かるエラーにする。
function loadSentry() {
  try {
    return require('@sentry/node');
  } catch (e) {
    throw new Error(
      '@sentry/node が未インストールです。Sentry通知を有効化するには `npm install @sentry/node` を実行してください'
    );
  }
}

function initSentry() {
  if (process.env.SENTRY_DSN) {
    loadSentry().init({ dsn: process.env.SENTRY_DSN });
  }
}

async function sendSentryNotification(event, data) {
  if (!process.env.SENTRY_DSN) return;
  loadSentry().captureMessage(`[${event}] ${JSON.stringify(data)}`);
}

module.exports = { initSentry, sendSentryNotification };
