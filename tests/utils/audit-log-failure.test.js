// tests/utils/audit-log-failure.test.js
// 監査ログが**書けなくなったとき**の振る舞い。
//
// きっかけ: サーバを普通に起動しただけで
//   [audit-log] Failed to write audit entry: ... Hash chain mismatch
// が全エントリぶん流れていた。ハッシュチェーンが一度壊れると以降すべての
// 書き込みが例外になり、その例外は握り潰されて標準エラーに出るだけ。
// アプリは平常どおり動き続け、**記録だけが静かに止まる**。
//
// 非否認性のために監査ログを持ち、その Merkle root を外部へアンカーしている製品で
// これは最悪の壊れ方にあたる。アンカラーは伸びない末尾をアンカーし続けるので、
// 外から見ると健全に映る。攻撃者はチェーンを一度壊すだけで以後の記録を止められる。
//
// ここで押さえるのは 3 点:
//   1. 書けなかった事実がプロセス内の状態として残り、外から観測できること
//   2. 書けなかったエントリを隔離ファイルへ退避し、記録自体は失わないこと
//   3. readiness がそれを落とすこと（記録が止まったままトラフィックを受けない）
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir, logPath, auditLog;

beforeEach(() => {
  jest.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditfail-'));
  logPath = path.join(dir, 'audit.log');
  process.env.AUDIT_LOG_PATH = logPath;
  delete process.env.AUDIT_HASH_PATH;
  auditLog = require('../../src/utils/audit-log');
  auditLog._resetAuditHealthForTest();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AUDIT_LOG_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('healthy path', () => {
  it('reports healthy and writes nothing to quarantine', () => {
    auditLog.appendAuditLog('order_created', { orderId: 'o1' });
    expect(auditLog.auditWriteHealth()).toMatchObject({ healthy: true, droppedEntries: 0 });
    expect(fs.existsSync(auditLog.quarantinePath())).toBe(false);
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('order_created');
  });
});

describe('when the entry cannot be written', () => {
  function breakWrites() {
    // 本体ログへの追記だけを壊して書き込み不能を再現する（ディスクフル・権限など）。
    // 隔離ファイルへの追記は生きている必要があるので、実関数を先に捕まえておく。
    const realAppend = fs.appendFileSync.bind(fs);
    jest.spyOn(fs, 'appendFileSync').mockImplementation((p, ...rest) => {
      if (String(p) === logPath) {
        const err = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      }
      return realAppend(p, ...rest);
    });
  }

  it('records the failure instead of only printing to stderr', () => {
    breakWrites();
    auditLog.appendAuditLog('payout_completed', { amountSats: 1000 });
    const h = auditLog.auditWriteHealth();
    expect(h.healthy).toBe(false);
    expect(h.droppedEntries).toBe(1);
    expect(h.lastAction).toBe('payout_completed');
    expect(h.lastReason).toMatch(/disk_full/);
    expect(h.firstFailureAt).not.toBeNull();
  });

  it('keeps the entry in a quarantine file rather than losing it', () => {
    // 繋がっていなくても残っている方が、記録を丸ごと失うよりよい。
    breakWrites();
    auditLog.appendAuditLog('payout_completed', { amountSats: 1000, txid: 'abc' });
    const quarantined = fs.readFileSync(auditLog.quarantinePath(), 'utf-8').trim().split('\n');
    expect(quarantined).toHaveLength(1);
    const row = JSON.parse(quarantined[0]);
    expect(row.entry).toContain('payout_completed');
    expect(row.entry).toContain('abc');
    expect(row.quarantinedAt).toBeTruthy();
  });

  it('counts every dropped entry, not just the first', () => {
    breakWrites();
    for (let i = 0; i < 3; i++) auditLog.appendAuditLog('order_created', { i });
    expect(auditLog.auditWriteHealth().droppedEntries).toBe(3);
    expect(fs.readFileSync(auditLog.quarantinePath(), 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  it('never throws into the caller', () => {
    // 監査の失敗で業務処理を落とさないのは従来どおり。黙って消さないだけ。
    breakWrites();
    expect(() => auditLog.appendAuditLog('order_created', {})).not.toThrow();
  });

  it('alerts the operator once, not on every dropped entry', () => {
    // 障害中に毎エントリ通知すると外部チャネルを溢れさせ、かえって埋もれる。
    const alerts = require('../../src/utils/external-alerts');
    const spy = jest.spyOn(alerts, 'notifyAll').mockResolvedValue([]);
    breakWrites();
    for (let i = 0; i < 5; i++) auditLog.appendAuditLog('order_created', { i });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('audit_log_write_failed', expect.objectContaining({ reason: 'disk_full' }));
  });
});

describe('size limit', () => {
  it('quarantines the entry and reports unhealthy when the log is full', () => {
    fs.writeFileSync(logPath, 'x');
    jest.spyOn(fs, 'statSync').mockReturnValue({ size: 999 * 1024 * 1024 });
    auditLog.appendAuditLog('order_created', { orderId: 'o9' });
    const h = auditLog.auditWriteHealth();
    expect(h.healthy).toBe(false);
    expect(h.lastReason).toMatch(/size_limit/);
    expect(fs.readFileSync(auditLog.quarantinePath(), 'utf-8')).toContain('o9');
  });
});
