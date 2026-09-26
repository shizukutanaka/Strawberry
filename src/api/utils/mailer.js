// メール送信ユーティリティ
const nodemailer = require('nodemailer');

// SMTP 応答が無い・遅い相手に接続が張り付くと、マスター認証コードのリクエストが
// そのままハングする。nodemailer 既定はタイムアウト無制限のため明示する。
const SMTP_TIMEOUT_MS = parseInt(process.env.SMTP_TIMEOUT_MS, 10) || 10_000;

// secure:false（587/STARTTLS）では STARTTLS が「あれば使う」opportunistic になるため、
// 対応しないサーバへは AUTH 認証情報が平文で流れる。既定で STARTTLS を必須化し、
// TLS を持たない社内リレー/ローカル dev だけ SMTP_REQUIRE_TLS=false で明示的に緩める。
const requireTLS = process.env.SMTP_REQUIRE_TLS !== 'false' && process.env.SMTP_REQUIRE_TLS !== '0';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: false,
  requireTLS,
  connectionTimeout: SMTP_TIMEOUT_MS,
  greetingTimeout: SMTP_TIMEOUT_MS,
  socketTimeout: SMTP_TIMEOUT_MS,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendMail(to, subject, html) {
  await transporter.sendMail({
    from: process.env.MASTER_EMAIL_FROM,
    to,
    subject,
    html
  });
}

module.exports = { sendMail };
