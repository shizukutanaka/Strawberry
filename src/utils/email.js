// src/utils/email.js - SendGrid/Mailgunメール送信ユーティリティ
const axios = require('axios');

// 外向き HTTP 呼出の共通安全設定（notifier.js / resilient-notify.js と同値）。
// timeout/maxContentLength: 外部 API の無限レスポンス・ハングでの DoS 防止。
// maxRedirects:0: 固定 URL のためリダイレクトは不要で、追従すると攻撃者制御の
// DNS/ドメイン経由の間接指定（SSRF 類）を防げない。
const SAFE_AXIOS_CONFIG = Object.freeze({
  timeout: 10_000,
  maxContentLength: 1_048_576,
  maxBodyLength: 1_048_576,
  maxRedirects: 0,
});

/**
 * Send email notification using SendGrid or Mailgun
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Text body
 * @param {string} [options.html] - HTML body (optional)
 * @param {Object} config - Email config (from process.env or config.js)
 * @returns {Promise<void>}
 */
async function sendEmailNotification({ to, subject, text, html }, config = process.env) {
  const provider = config.EMAIL_PROVIDER || 'sendgrid';
  if (provider === 'sendgrid') {
    const apiKey = config.SENDGRID_API_KEY;
    const from = config.EMAIL_FROM || config.SENDGRID_FROM;
    if (!apiKey || !from) throw new Error('SendGrid API key or sender not set');
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [
        html ? { type: 'text/html', value: html } : { type: 'text/plain', value: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...SAFE_AXIOS_CONFIG,
    });
  } else if (provider === 'mailgun') {
    const apiKey = config.MAILGUN_API_KEY;
    const domain = config.MAILGUN_DOMAIN;
    const from = config.EMAIL_FROM || `noreply@${domain}`;
    if (!apiKey || !domain) throw new Error('Mailgun API key or domain not set');
    const auth = Buffer.from(`api:${apiKey}`).toString('base64');
    await axios.post(`https://api.mailgun.net/v3/${domain}/messages`,
      new URLSearchParams({ from, to, subject, text, html }),
      { headers: { Authorization: `Basic ${auth}` }, ...SAFE_AXIOS_CONFIG }
    );
  } else {
    throw new Error('Unknown EMAIL_PROVIDER');
  }
}

module.exports = { sendEmailNotification };
