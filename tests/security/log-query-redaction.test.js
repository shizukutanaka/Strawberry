// tests/security/log-query-redaction.test.js
// middleware/logger.js がログへ書く URL に含まれる機密クエリパラメータの
// マスキングを検証する（middleware/audit.js の query マスキングとの一貫性）。
const fs = require('fs');

const loggerMod = require('../../src/api/middleware/logger');
const { redactUrlQuery, errorLogger } = loggerMod;
const { logger } = require('../../src/utils/logger');

describe('redactUrlQuery', () => {
  it('masks sensitive query params and preserves non-sensitive ones', () => {
    expect(redactUrlQuery('/api/v1/x?foo=1&token=abc123&page=2'))
      .toBe('/api/v1/x?foo=1&token=[MASKED]&page=2');
  });

  it('masks all sensitive key variants (case-insensitive, snake_case)', () => {
    const out = redactUrlQuery(
      '/x?PASSWORD=a&Secret=b&api_key=c&apiKey=d&refreshToken=e&accessToken=f&jwt=g&macaroon=h&mnemonic=i&seed=j&privateKey=k&email=l'
    );
    expect(out).not.toMatch(/=[a-l](&|$)/);
    expect(out).toContain('api_key=[MASKED]');
    expect(out).toContain('PASSWORD=[MASKED]');
  });

  it('leaves URLs without query untouched', () => {
    expect(redactUrlQuery('/api/v1/gpus')).toBe('/api/v1/gpus');
    expect(redactUrlQuery('/x?ok=1&ok2=2')).toBe('/x?ok=1&ok2=2');
  });

  it('handles non-string input and empty values', () => {
    expect(redactUrlQuery(undefined)).toBe(undefined);
    expect(redactUrlQuery(null)).toBe(null);
    expect(redactUrlQuery('/x?token=')).toBe('/x?token=[MASKED]');
  });
});

describe('errorLogger path redaction', () => {
  it('logs the request path with sensitive query params masked', () => {
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const req = { id: 'r1', method: 'GET', originalUrl: '/api/v1/x?token=secret123' };
    const next = jest.fn();
    errorLogger(new Error('boom'), req, {}, next);
    expect(next).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: '/api/v1/x?token=[MASKED]' })
    );
    spy.mockRestore();
  });
});

describe('logger.js source wiring', () => {
  const src = fs.readFileSync(require.resolve('../../src/api/middleware/logger.js'), 'utf-8');

  it('morgan request/dev loggers use the redacted safeUrl token, not raw :url', () => {
    expect(src).toMatch(/morgan\.token\('safeUrl'/);
    const morganCalls = src.match(/morgan\(\s*'[^']+'/g) || [];
    expect(morganCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of morganCalls) expect(call).toContain(':safeUrl');
    for (const call of morganCalls) expect(call).not.toContain(':url ');
  });

  it('all originalUrl sinks go through redactUrlQuery', () => {
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const uses = code.match(/req\.originalUrl/g) || [];
    const redacted = code.match(/redactUrlQuery\(req\.originalUrl\)/g) || [];
    expect(redacted.length).toBe(uses.length);
  });
});
