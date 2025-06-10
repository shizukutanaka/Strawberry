// scripts/sentry-notify.js
// Sentry通知モジュール（DSNは環境変数SENTRY_DSNで指定）
const Sentry = require('@sentry/node');

function initSentry() {
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN });
  }
}

async function sendSentryNotification(event, data) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureMessage(`[${event}] ${JSON.stringify(data)}`);
}

module.exports = { initSentry, sendSentryNotification };
