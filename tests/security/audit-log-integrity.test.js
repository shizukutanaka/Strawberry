// Regression: the tamper-evident audit hash chain (src/utils/audit-log.js) must
// be the ONLY writer of its log file. The HTTP audit middleware and the
// p2p-notify daemon used to append to the same file, interleaving un-chained
// lines that made verifyAuditLogIntegrity() always fail.
//
// Isolation: this suite points AUDIT_LOG_PATH at a unique temp file so that
// other suites running in parallel (which call appendAuditLog against the
// default logs/audit.log) cannot pollute the chain under test. Asserting on the
// shared global file made these tests flaky when run alongside the rest.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendAuditLog, verifyAuditLogIntegrity } = require('../../src/utils/audit-log');

const GLOBAL_LOG = path.join(__dirname, '../../logs/audit.log');

let TMP_DIR, LOG, HASH;
const savedEnv = {};

beforeAll(() => {
  savedEnv.log = process.env.AUDIT_LOG_PATH;
  savedEnv.hash = process.env.AUDIT_HASH_PATH;
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-integrity-'));
  LOG = path.join(TMP_DIR, 'audit.log');
  HASH = path.join(TMP_DIR, 'audit.hash');
  process.env.AUDIT_LOG_PATH = LOG;
  process.env.AUDIT_HASH_PATH = HASH;
});

afterAll(() => {
  if (savedEnv.log === undefined) delete process.env.AUDIT_LOG_PATH;
  else process.env.AUDIT_LOG_PATH = savedEnv.log;
  if (savedEnv.hash === undefined) delete process.env.AUDIT_HASH_PATH;
  else process.env.AUDIT_HASH_PATH = savedEnv.hash;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

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
    // Verify that loading audit.js (with no AUDIT_LOG_PATH set) does not synchronously
    // write to the tamper-evident audit.log. We spy on fs.appendFileSync for the duration
    // of the synchronous require() rather than snapshotting the file, because a background
    // service-monitor setInterval can fire asynchronously between before/after reads and
    // produce spurious diff lines in the file-content comparison.
    const saved = process.env.AUDIT_LOG_PATH;
    delete process.env.AUDIT_LOG_PATH;
    jest.resetModules();
    const writtenPaths = [];
    const origAppend = fs.appendFileSync.bind(fs);
    jest.spyOn(fs, 'appendFileSync').mockImplementation((p, data, opts) => {
      writtenPaths.push(String(p));
      return origAppend(p, data, opts);
    });
    try {
      require('../../src/api/middleware/audit');
    } finally {
      jest.restoreAllMocks();
      if (saved !== undefined) process.env.AUDIT_LOG_PATH = saved;
      else delete process.env.AUDIT_LOG_PATH;
    }
    // audit.js has no top-level side effects, so no appendFileSync should fire during load.
    const auditLogWrites = writtenPaths.filter((p) => p.endsWith('audit.log'));
    expect(auditLogWrites).toHaveLength(0);
  });
});
