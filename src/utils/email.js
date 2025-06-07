// src/utils/email.js - SendGrid/Mailgunメール送信ユーティリティ
const axios = require('axios');

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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
  } else if (provider === 'mailgun') {
    const apiKey = config.MAILGUN_API_KEY;
    const domain = config.MAILGUN_DOMAIN;
    const from = config.EMAIL_FROM || `noreply@${domain}`;
    if (!apiKey || !domain) throw new Error('Mailgun API key or domain not set');
    const auth = Buffer.from(`api:${apiKey}`).toString('base64');
    await axios.post(`https://api.mailgun.net/v3/${domain}/messages`,
      new URLSearchParams({ from, to, subject, text, html }),
      { headers: { Authorization: `Basic ${auth}` } }
    );
  } else {
    throw new Error('Unknown EMAIL_PROVIDER');
  }
}

module.exports = { sendEmailNotification };
