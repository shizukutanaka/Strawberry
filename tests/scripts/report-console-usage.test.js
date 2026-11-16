// tests/scripts/report-console-usage.test.js — report-console-usage.js の契約テスト。
const path = require('path');
const { report } = require('../../scripts/report-console-usage');

describe('report-console-usage', () => {
  const r = report();

  test('src/ を走査し console.* 使用ファイルを収集する', () => {
    expect(r.summary.filesWithConsole).toBeGreaterThan(0);
    expect(r.files.every((f) => f.file && typeof f.count === 'number')).toBe(true);
  });

  test('ロガー実装・監査ログは legit として分離される', () => {
    const auditLog = r.files.find((f) => f.file === path.join('utils', 'audit-log.js'));
    expect(auditLog).toBeDefined();
    expect(auditLog.legit).toBe(true);
    expect(r.summary.driftFiles).toBeLessThan(r.summary.filesWithConsole);
  });

  test('drift 集計がファイル内訳と一致する', () => {
    const drift = r.files.filter((f) => !f.legit);
    expect(r.summary.driftFiles).toBe(drift.length);
    expect(r.summary.driftCalls).toBe(drift.reduce((s, f) => s + f.count, 0));
  });

  test('使用種別（log/error/warn）の内訳を持つ', () => {
    const any = r.files.find((f) => f.count > 0);
    expect(Object.keys(any.byKind).every((k) => ['log', 'error', 'warn', 'info', 'debug'].includes(k))).toBe(true);
    expect(Object.values(any.byKind).reduce((a, b) => a + b, 0)).toBe(any.count);
  });
});
