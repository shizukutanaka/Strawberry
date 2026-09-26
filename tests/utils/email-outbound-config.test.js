// tests/utils/email-outbound-config.test.js
// email.js / mailer.js の外向き呼び出し安全設定の回帰テスト。
// webhook.js と同じ取りこぼし: axios 既定（timeout 無し・maxRedirects:5）で
// SendGrid/Mailgun へ POST していた。nodemailer もタイムアウト・STARTTLS 未強制だった。

describe('email.js の SendGrid/Mailgun 呼出に安全設定がある', () => {
  it('両プロバイダの axios.post に SAFE_AXIOS_CONFIG を渡す（ソースガード）', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/email.js'), 'utf-8'
    );
    const calls = src.match(/axios\.post\([\s\S]*?SAFE_AXIOS_CONFIG/g) || [];
    expect(calls.length).toBe(2);
  });

  it('sendEmailNotification が実際に timeout/maxRedirects を axios へ渡す', async () => {
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {} });
    const { sendEmailNotification } = require('../../src/utils/email');

    await sendEmailNotification(
      { to: 'a@b.c', subject: 's', text: 't' },
      { EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'k', EMAIL_FROM: 'f@x.y' }
    );
    const cfg = axios.post.mock.calls[0][2];
    expect(cfg.timeout).toBeGreaterThan(0);
    expect(cfg.maxRedirects).toBe(0);
    axios.post.mockRestore();
  });
});

describe('mailer.js の SMTP トランスポート設定', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function getCreateArg() {
    const nodemailer = require('nodemailer');
    jest.spyOn(nodemailer, 'createTransport');
    require('../../src/api/utils/mailer');
    return nodemailer.createTransport.mock.calls[0][0];
  }

  it('タイムアウト3種と requireTLS（既定）を設定する', () => {
    delete process.env.SMTP_REQUIRE_TLS;
    delete process.env.SMTP_TIMEOUT_MS;
    const arg = getCreateArg();
    expect(arg.connectionTimeout).toBeGreaterThan(0);
    expect(arg.greetingTimeout).toBeGreaterThan(0);
    expect(arg.socketTimeout).toBeGreaterThan(0);
    expect(arg.requireTLS).toBe(true);
  });

  it('SMTP_REQUIRE_TLS=false で明示的に緩和できる', () => {
    process.env.SMTP_REQUIRE_TLS = 'false';
    const arg = getCreateArg();
    expect(arg.requireTLS).toBe(false);
  });

  it('SMTP_TIMEOUT_MS でタイムアウトを調整できる', () => {
    process.env.SMTP_TIMEOUT_MS = '3000';
    const arg = getCreateArg();
    expect(arg.connectionTimeout).toBe(3000);
  });
});
