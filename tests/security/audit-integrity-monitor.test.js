// tests/security/audit-integrity-monitor.test.js
//
// 問: verifyAuditLogIntegrity() は本番コードのどこからも呼ばれていなかった
// （grep で確認できた: 呼び出し元はテストのみ）。HMAC ハッシュチェーンは起動時に
// 一度検証されるだけで、稼働中の改ざんは次の再起動まで気づかれなかった。
// このモジュールは同じ検証を setInterval で定期実行する。検出しても自動修復・
// 強制終了はしない（断定できない異常は記録・通知に留める、というこのコードベース
// 全体の方針）。
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('audit-integrity-monitor', () => {
  let tmpDir;
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.log = process.env.AUDIT_LOG_PATH;
    savedEnv.hash = process.env.AUDIT_HASH_PATH;
    savedEnv.interval = process.env.AUDIT_INTEGRITY_CHECK_INTERVAL_MS;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-monitor-'));
    process.env.AUDIT_LOG_PATH = path.join(tmpDir, 'audit.log');
    process.env.AUDIT_HASH_PATH = path.join(tmpDir, 'audit.hash');
    jest.resetModules();
  });

  afterEach(() => {
    try { require('../../src/security/audit-integrity-monitor').stop(); } catch (_) {}
    if (savedEnv.log === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = savedEnv.log;
    if (savedEnv.hash === undefined) delete process.env.AUDIT_HASH_PATH;
    else process.env.AUDIT_HASH_PATH = savedEnv.hash;
    if (savedEnv.interval === undefined) delete process.env.AUDIT_INTEGRITY_CHECK_INTERVAL_MS;
    else process.env.AUDIT_INTEGRITY_CHECK_INTERVAL_MS = savedEnv.interval;
    jest.resetModules();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('runOnce() calls the real verifier and surfaces a detected tamper through auditIntegrityHealth', () => {
    const auditLog = require('../../src/utils/audit-log');
    const monitor = require('../../src/security/audit-integrity-monitor');
    auditLog.appendAuditLog('a', {});
    fs.appendFileSync(process.env.AUDIT_LOG_PATH, JSON.stringify({ foreign: true }) + '\n');

    const result = monitor.runOnce();
    expect(result.ok).toBe(false);
    expect(auditLog.auditIntegrityHealth().detected).toBe(true);
  });

  it('runOnce() reports ok for an untouched chain', () => {
    const auditLog = require('../../src/utils/audit-log');
    const monitor = require('../../src/security/audit-integrity-monitor');
    auditLog.appendAuditLog('a', {});
    expect(monitor.runOnce()).toEqual({ ok: true });
  });

  it('honors AUDIT_INTEGRITY_CHECK_INTERVAL_MS', () => {
    process.env.AUDIT_INTEGRITY_CHECK_INTERVAL_MS = '1234';
    jest.resetModules();
    const monitor = require('../../src/security/audit-integrity-monitor');
    expect(monitor.intervalMs()).toBe(1234);
  });

  it('start()/stop() are idempotent and do not throw', () => {
    const monitor = require('../../src/security/audit-integrity-monitor');
    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();
  });

  it('is wired into server startup (regression: the check existed but nothing ran it)', () => {
    const src = fs.readFileSync(require.resolve('../../src/api/server.js'), 'utf-8');
    expect(src).toMatch(/audit-integrity-monitor/);
  });

  it('verifyAuditLogIntegrity now has at least one production caller, not just tests', () => {
    const SRC = path.resolve(__dirname, '../../src');
    const jsFilesUnder = (dir, out = []) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) jsFilesUnder(full, out);
        else if (ent.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const callers = jsFilesUnder(SRC)
      .filter((f) => !f.endsWith(path.join('utils', 'audit-log.js'))) // 定義自体は除く
      .filter((f) => /verifyAuditLogIntegrity\(\)|checkIntegrity\(\)/.test(fs.readFileSync(f, 'utf-8')));
    expect(callers.length).toBeGreaterThan(0);
  });
});
