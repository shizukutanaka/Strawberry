// tests/security/audit-url-redaction.test.js
// middleware/audit.js の url フィールドに含まれる機密クエリのマスキングと、
// scripts/slack-notify-notion.js の .env 読み込み順序を検証する。
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('audit middleware: url field stores path only', () => {
  let tmpDir;
  const OLD_ENV = process.env.AUDIT_LOG_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-redact-'));
    process.env.AUDIT_LOG_PATH = path.join(tmpDir, 'access-audit.log');
    jest.resetModules();
  });
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = OLD_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runMiddleware(originalUrl) {
    const auditLogger = require('../../src/api/middleware/audit');
    const req = {
      originalUrl,
      method: 'GET',
      ip: '127.0.0.1',
      query: {},
    };
    const res = {
      statusCode: 200,
      json() { return this; },
      on() {},
    };
    auditLogger(req, res, () => {});
    res.json({ ok: true }); // ログ書き込みは res.json ラップ経由で同期実行される
    const raw = fs.readFileSync(process.env.AUDIT_LOG_PATH, 'utf8').trim();
    return JSON.parse(raw.split('\n').pop());
  }

  it('strips the raw query string (query is logged separately, masked)', () => {
    const entry = runMiddleware('/api/v1/x?token=sekret&page=2');
    expect(entry.url).toBe('/api/v1/x');
    expect(entry.url).not.toContain('sekret');
  });

  it('keeps urls without a query unchanged', () => {
    const entry = runMiddleware('/api/v1/gpus');
    expect(entry.url).toBe('/api/v1/gpus');
  });

  it('handles a missing originalUrl without throwing', () => {
    const entry = runMiddleware(undefined);
    expect(entry.url).toBe('');
  });
});

describe('slack-notify-notion.js: .env loading order', () => {
  const src = fs.readFileSync(
    require.resolve('../../scripts/slack-notify-notion.js'), 'utf-8'
  );

  it('loads dotenv before requiring slack-feedback-bot (env captured at require time)', () => {
    const dotenvIdx = src.indexOf("require('dotenv').config()");
    const botIdx = src.indexOf("require('./slack-feedback-bot')");
    expect(dotenvIdx).toBeGreaterThanOrEqual(0);
    expect(botIdx).toBeGreaterThanOrEqual(0);
    expect(dotenvIdx).toBeLessThan(botIdx);
  });

  it('guards report read errors with an explicit failure', () => {
    expect(src).toMatch(/try\s*\{[\s\S]*?readFileSync[\s\S]*?catch/);
    expect(src).toMatch(/process\.exitCode\s*=\s*1/);
  });
});
