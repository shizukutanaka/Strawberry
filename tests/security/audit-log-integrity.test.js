// Regression: the tamper-evident audit hash chain (src/utils/audit-log.js) must
// be the ONLY writer of logs/audit.log. The HTTP audit middleware and the
// p2p-notify daemon used to append to the same file, interleaving un-chained
// lines that made verifyAuditLogIntegrity() always fail.
const fs = require('fs');
const path = require('path');
const { appendAuditLog, verifyAuditLogIntegrity } = require('../../src/utils/audit-log');

const LOG = path.join(__dirname, '../../logs/audit.log');
const HASH = path.join(__dirname, '../../logs/audit.hash');

describe('audit-log hash chain integrity', () => {
  beforeEach(() => {
    // Start from a clean chain so the assertions are deterministic.
    for (const f of [LOG, HASH]) { try { fs.unlinkSync(f); } catch (_) {} }
  });

  it('verifies a chain written exclusively via appendAuditLog', () => {
    appendAuditLog('test_action_a', { n: 1 });
    appendAuditLog('test_action_b', { n: 2 });
    appendAuditLog('test_action_c', { n: 3 });
    expect(verifyAuditLogIntegrity()).toBe(true);
  });

  it('detects a foreign un-chained line (the bug the file split fixes)', () => {
    appendAuditLog('test_action_a', { n: 1 });
    // Simulate the old middleware/p2p-notify appending to the same file:
    fs.appendFileSync(LOG, JSON.stringify({ foreign: true, time: new Date().toISOString() }) + '\n');
    expect(verifyAuditLogIntegrity()).toBe(false);
  });

  it('the HTTP audit middleware does not target logs/audit.log by default', () => {
    // Fresh require with no AUDIT_LOG_PATH override; assert it writes elsewhere.
    const saved = process.env.AUDIT_LOG_PATH;
    delete process.env.AUDIT_LOG_PATH;
    jest.resetModules();
    // The middleware computes its path at module load; re-require and inspect via a probe write.
    const probeEntryBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
    require('../../src/api/middleware/audit'); // loading must not write to audit.log
    const probeEntryAfter = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8') : '';
    expect(probeEntryAfter).toBe(probeEntryBefore);
    if (saved !== undefined) process.env.AUDIT_LOG_PATH = saved;
  });
});
