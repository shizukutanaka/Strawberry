// tests/utils/audit-log-max-mb.test.js
// MAX_AUDIT_LOG_MB がタイポ等で NaN になるとサイズ上限が無言で無効化され、
// ディスク枯渇 DoS が復活する。NaN/負値は既定 50MB へフォールバックすることを固定。
const MB = 1024 * 1024;

function loadMaxBytes(value) {
  if (value === undefined) delete process.env.MAX_AUDIT_LOG_MB;
  else process.env.MAX_AUDIT_LOG_MB = value;
  jest.resetModules();
  return require('../../src/utils/audit-log').MAX_AUDIT_LOG_BYTES;
}

describe('MAX_AUDIT_LOG_MB parsing', () => {
  const saved = process.env.MAX_AUDIT_LOG_MB;
  afterAll(() => {
    if (saved === undefined) delete process.env.MAX_AUDIT_LOG_MB;
    else process.env.MAX_AUDIT_LOG_MB = saved;
    jest.resetModules();
  });

  it('defaults to 50MB when unset or empty', () => {
    expect(loadMaxBytes(undefined)).toBe(50 * MB);
    expect(loadMaxBytes('')).toBe(50 * MB);
  });

  it('falls back to 50MB on NaN (typo) — cap must not silently disable', () => {
    expect(loadMaxBytes('abc')).toBe(50 * MB);
    expect(loadMaxBytes('NaN')).toBe(50 * MB);
    expect(loadMaxBytes('-50x')).toBe(50 * MB);
  });

  it('falls back to 50MB on negative values', () => {
    expect(loadMaxBytes('-10')).toBe(50 * MB);
  });

  it('rejects partial numeric parses — a typo must not silently freeze auditing', () => {
    // parseInt('0oops') は 0 を返し、緩い検証だと「監査停止」と誤解釈されて
    // 全監査記録が黙って失われる。数字のみの完全一致を要求する。
    expect(loadMaxBytes('0oops')).toBe(50 * MB);
    expect(loadMaxBytes('0x10')).toBe(50 * MB);
    expect(loadMaxBytes('1.5')).toBe(50 * MB);
    expect(loadMaxBytes(' 25 junk')).toBe(50 * MB);
  });

  it('rejects huge values that would overflow bytes to Infinity', () => {
    // MB→bytes 換算で Infinity になると全サイズ比較が false になり上限が消える。
    // 1TB(MB単位) 超は設定ミスとして既定値へ。
    expect(loadMaxBytes('999999999999999999')).toBe(50 * MB);
    expect(loadMaxBytes('1048577')).toBe(50 * MB);
    expect(loadMaxBytes('1048576')).toBe(1048576 * MB);
  });

  it('honours valid values and explicit 0 (freeze)', () => {
    expect(loadMaxBytes('100')).toBe(100 * MB);
    expect(loadMaxBytes('0')).toBe(0);
  });
});

describe('MAX_AUDIT_LOG_MB=0 disables writes entirely', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const saved = { mb: process.env.MAX_AUDIT_LOG_MB, log: process.env.AUDIT_LOG_PATH };

  afterAll(() => {
    if (saved.mb === undefined) delete process.env.MAX_AUDIT_LOG_MB;
    else process.env.MAX_AUDIT_LOG_MB = saved.mb;
    if (saved.log === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = saved.log;
    jest.resetModules();
  });

  it('writes nothing even when the log file does not exist yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-zero-'));
    const logPath = path.join(dir, 'audit.log');
    process.env.MAX_AUDIT_LOG_MB = '0';
    process.env.AUDIT_LOG_PATH = logPath;
    jest.resetModules();
    const { appendAuditLog } = require('../../src/utils/audit-log');
    appendAuditLog('test_action', { x: 1 });
    // ファイル未作成でも1行も書かれない（ENOENT 握りつぶし経路の回帰固定）
    expect(fs.existsSync(logPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
