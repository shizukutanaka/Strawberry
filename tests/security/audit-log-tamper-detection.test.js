// tests/security/audit-log-tamper-detection.test.js
//
// audit-anchor.js の主張: 監査ログは「HMAC ハッシュチェーンで tamper-evident」。
//
// 問: tamper-evident は、誰かがそれを見て初めて意味を持つ。**誰がいつ見るのか。**
// 答（修正前）: 起動時、プロセス内キャッシュを作る最初の appendAuditLog 呼び出しの中で
// 一度だけ。それ以降 appendAuditLog はキャッシュした prevHash から次のハッシュを
// 計算するだけで、ディスク上の実ファイルを見直さない。稼働中にログファイルへ直接
// 書き込まれる改ざん（コンテナ内 RCE・ログボリュームの sidecar・共有ボリューム経由）は、
// 次の再起動まで検出されない。verifyAuditLogIntegrity() を呼ぶ本番コードは実在せず、
// テストだけが呼んでいた。
//
// 直し方: 同じ検証を稼働中も定期的に回す（src/security/audit-integrity-monitor.js）。
// 検出しても自動修復・強制停止はしない。稼働中の検出は誤検知を排除できないので、
// それだけで製品を落とすのは検出しないより悪い自傷になり得る（このコードベース全体の
// 「断定できない異常は記録・通知に留める」という方針に合わせる）。
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshAuditLog(tmpDir) {
  process.env.AUDIT_LOG_PATH = path.join(tmpDir, 'audit.log');
  process.env.AUDIT_HASH_PATH = path.join(tmpDir, 'audit.hash');
  jest.resetModules();
  return require('../../src/utils/audit-log');
}

describe('audit log tamper detection runs continuously, not only at boot', () => {
  let tmpDir;
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.log = process.env.AUDIT_LOG_PATH;
    savedEnv.hash = process.env.AUDIT_HASH_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-tamper-'));
  });

  afterEach(() => {
    if (savedEnv.log === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = savedEnv.log;
    if (savedEnv.hash === undefined) delete process.env.AUDIT_HASH_PATH;
    else process.env.AUDIT_HASH_PATH = savedEnv.hash;
    jest.resetModules();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('checkIntegrity() reports healthy for a chain nobody has touched', () => {
    const auditLog = freshAuditLog(tmpDir);
    auditLog.appendAuditLog('order_completed', { orderId: 'o1' });
    auditLog.appendAuditLog('payout_sent', { amountSats: 50000 });
    expect(auditLog.checkIntegrity()).toBe(true);
    expect(auditLog.auditIntegrityHealth().detected).toBe(false);
  });

  it('checkIntegrity() catches a line rewritten directly on disk — the exact gap a boot-only check misses', () => {
    const auditLog = freshAuditLog(tmpDir);
    auditLog.appendAuditLog('order_completed', { orderId: 'o1' });
    auditLog.appendAuditLog('payout_sent', { amountSats: 50000 });

    // 攻撃者が RCE でログを直接書き換える。.hash ファイルには触れない —
    // appendAuditLog を経由しないので、プロセスの prevHash キャッシュはこれを知らない。
    const logPath = process.env.AUDIT_LOG_PATH;
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.detail.amountSats = 5000000; // 桁を書き換えて送金額を偽装
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    // 改ざん後もキャッシュ経由の追記は「正常」に見え続ける — これが検出の要点。
    auditLog.appendAuditLog('unrelated_action', {});

    expect(auditLog.checkIntegrity()).toBe(false);
    const health = auditLog.auditIntegrityHealth();
    expect(health.detected).toBe(true);
    expect(health.detectedAt).toBeTruthy();
  });

  it('once detected, the state does not clear itself (a human must investigate)', () => {
    const auditLog = freshAuditLog(tmpDir);
    auditLog.appendAuditLog('a', {});
    fs.appendFileSync(process.env.AUDIT_LOG_PATH, JSON.stringify({ foreign: true }) + '\n');
    expect(auditLog.checkIntegrity()).toBe(false);
    expect(auditLog.auditIntegrityHealth().detected).toBe(true);
    // Even if the file is somehow put back, the process keeps flagging it as compromised.
    expect(auditLog.auditIntegrityHealth().detected).toBe(true);
  });

  it('alerts exactly once even when checked repeatedly (does not flood the channel every cycle)', async () => {
    const auditLog = freshAuditLog(tmpDir);
    auditLog.appendAuditLog('a', {});
    fs.appendFileSync(process.env.AUDIT_LOG_PATH, JSON.stringify({ foreign: true }) + '\n');

    const externalAlerts = require('../../src/utils/external-alerts');
    const spy = jest.spyOn(externalAlerts, 'notifyAll').mockResolvedValue([]);
    try {
      expect(auditLog.checkIntegrity()).toBe(false);
      expect(auditLog.checkIntegrity()).toBe(false);
      expect(auditLog.checkIntegrity()).toBe(false);
      await Promise.resolve(); // notifyAll is fire-and-forget; let the microtask run.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('audit_log_tamper_detected', expect.any(Object));
    } finally {
      spy.mockRestore();
    }
  });

  it('appendAuditLog stays O(1): it does not re-verify the whole file on every write', () => {
    // 意図的な設計選択の記録。毎書き込みで全文再検証すると、ログが育つほど書き込みが
    // 遅くなる。だからこそ定期チェック（audit-integrity-monitor）が別に要る。
    const src = fs.readFileSync(require.resolve('../../src/utils/audit-log.js'), 'utf-8');
    const start = src.indexOf('function appendAuditLog');
    const end = src.indexOf('function _recordFailure');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/verifyAuditLogIntegrity\(\)/);
  });
});
