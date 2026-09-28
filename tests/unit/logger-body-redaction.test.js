// tests/unit/logger-body-redaction.test.js
// middleware/logger.js の :body トークン用リダクションを直接検証する。
// devRequestLogger は NODE_ENV=development でボディを平文ログへ流すため、
// クレデンシャル系フィールドが残ると dev ログ/共有ターミナルへ漏洩する。
const { redactBodyForLog } = require('../../src/api/middleware/logger');

describe('redactBodyForLog', () => {
  it('masks every credential-bearing field used by the API routes', () => {
    const body = {
      password: 'p',           // login/register
      currentPassword: 'cp',   // PUT /me/password
      newPassword: 'np',
      token: 't',              // master-auth TOTP
      refreshToken: 'rt',      // POST /refresh, /logout
      accessToken: 'at',
      idToken: 'idt',          // Google OAuth
      paymentRequest: 'lnbc…', // BOLT11 invoice
      code: '123456',          // mail verification code
      mailCode: '654321',
      apiKey: 'k',
      totp: '000000',
      secret: 's',
    };
    const redacted = redactBodyForLog(body);
    for (const key of Object.keys(body)) {
      expect(redacted[key]).toBe('[REDACTED]');
    }
  });

  it('keeps non-credential fields untouched for debuggability', () => {
    const body = { email: 'a@b.c', role: 'provider', orderId: 'o1', reason: 'why', comment: 'ok' };
    expect(redactBodyForLog(body)).toEqual(body);
  });

  it('does not mutate the original object', () => {
    const body = { password: 'p', email: 'e' };
    redactBodyForLog(body);
    expect(body.password).toBe('p');
  });

  it('matches keys case-insensitively', () => {
    expect(redactBodyForLog({ RefreshToken: 'x', PASSWORD: 'y' }))
      .toEqual({ RefreshToken: '[REDACTED]', PASSWORD: '[REDACTED]' });
  });

  it('returns non-object input as-is', () => {
    expect(redactBodyForLog(undefined)).toBeUndefined();
    expect(redactBodyForLog('str')).toBe('str');
  });
});
