// security-audit: フィンガープリント差分通知の判定ロジック（exec/ネットワークなし）
const path = require('path');
const fs = require('fs');
const os = require('os');
const { auditDependencies, computeFingerprint } = require('../src/security-audit');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-audit-'));
const stateFile = path.join(tmpDir, 'state.json');

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

const auditJson = (vulns) => ({
  vulnerabilities: Object.fromEntries(vulns.map(([n, s]) => [n, { severity: s }])),
  metadata: { vulnerabilities: { total: vulns.length } },
});

describe('security-audit.auditDependencies', () => {
  it('脆弱性0件では通知しない', () => {
    const notify = jest.fn(() => 0);
    const r = auditDependencies(auditJson([]), { stateFile, notify });
    expect(r).toEqual({ vulnCount: 0, changed: false, notifiedChannels: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('新規脆弱性セットは通知し、同一セットは再通知しない', () => {
    const notify = jest.fn(() => 2);
    const first = auditDependencies(auditJson([['lodash', 'high']]), { stateFile, notify });
    expect(first.changed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    // 同一セット → 再通知なし
    const second = auditDependencies(auditJson([['lodash', 'high']]), { stateFile, notify });
    expect(second.changed).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    // セットが変化（追加）→ 通知
    const third = auditDependencies(auditJson([['lodash', 'high'], ['axios', 'critical']]), { stateFile, notify });
    expect(third.changed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('axios:critical');
  });

  it('computeFingerprint は名前:深刻度をソートして返す', () => {
    const fp = computeFingerprint(auditJson([['b', 'low'], ['a', 'critical']]));
    expect(fp).toEqual({ total: 2, ids: ['a:critical', 'b:low'] });
  });
});
