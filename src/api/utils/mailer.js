// メール送信ユーティリティ
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: false,
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
