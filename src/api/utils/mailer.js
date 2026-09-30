// メール送信ユーティリティ（master-auth の認証コード送信経路）
// src/utils/email.js（SendGrid/Mailgun HTTP API）とは別系統で、こちらは
// nodemailer による SMTP 直送。マスター3段階認証のコード配送を担うため
// 認証情報の機密性がクリティカル。
const nodemailer = require('nodemailer');

// SMTP 設定が未投入なら、nodemailer の不明瞭な接続失敗ではなく
// 「どの env が足りないか」の分かるエラーで止める。
function requiredEnv(name, purpose) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です（${purpose}に必要）。.env に設定してください`);
  return v;
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = requiredEnv('SMTP_HOST', 'master-auth のメール認証コード送信');
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = port === 465;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    // 587/25 は STARTTLS（opportunistic）が既定 — 相手サーバが STARTTLS 非対応だと
    // SMTP_USER/SMTP_PASS の認証情報を平文で送ってしまう。requireTLS で STARTTLS 非
    // 成功時は送信自体を失敗させる（utils/email.js の経路と同じ方針）。
    // TLS を持たない社内リレー/ローカル dev だけ SMTP_REQUIRE_TLS=false で明示的に緩める。
    requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false' && process.env.SMTP_REQUIRE_TLS !== '0',
    auth: {
      user: requiredEnv('SMTP_USER', 'SMTP 認証'),
      pass: requiredEnv('SMTP_PASS', 'SMTP 認証'),
    },
    // タイムアウト未設定だと応答しない SMTP サーバで master-auth のログイン要求が
    // 永久滞留する。connection/greeting/socket の3系統を明示する。
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || process.env.SMTP_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || process.env.SMTP_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || process.env.SMTP_TIMEOUT_MS || 30000),
  });
  return transporter;
}

async function sendMail(to, subject, html) {
  const t = getTransporter();
  const from = requiredEnv('MASTER_EMAIL_FROM', 'メール送信の差出人');
  await t.sendMail({ from, to, subject, html });
}

module.exports = { sendMail };
