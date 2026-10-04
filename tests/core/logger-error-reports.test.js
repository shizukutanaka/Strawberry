// src/core/logger.js の error-reports 永続化契約を固定する。
// レポートはクラッシュ直前調査用スナップショットだが、上限なく蓄積すると
// エラー連発時にディスクを埋めるため MAX_ERROR_REPORTS で刈り取る。
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('core/logger reportError', () => {
  let tmpLogDir;
  let logger;

  beforeEach(() => {
    tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    process.env.LOG_DIR = tmpLogDir;
    jest.resetModules();
    ({ logger } = require('../../src/core/logger'));
  });

  afterEach(() => {
    delete process.env.LOG_DIR;
    // DailyRotateFile のストリームを閉じてから dir を消す — 閉じずに消すと
    // 次回書込みで ENOENT の unhandled 'error' が飛びワーカーが落ちる
    try { logger.close(); } catch (_) {}
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  });

  const reportsDir = () => path.join(tmpLogDir, 'error-reports');
  const listReports = () => fs.existsSync(reportsDir())
    ? fs.readdirSync(reportsDir()).filter(f => f.endsWith('.json'))
    : [];

  it('レポートを error-reports/ へ JSON として確実に残す（同期的に書き込まれる）', async () => {
    await logger.reportError(new Error('probe'), { type: 'test' });
    const files = listReports();
    expect(files).toHaveLength(1);
    const report = JSON.parse(fs.readFileSync(path.join(reportsDir(), files[0]), 'utf8'));
    expect(report.error.message).toBe('probe');
    expect(report.context.type).toBe('test');
  });

  it('同一ミリ秒の連続レポートでも上書き消失しない', async () => {
    // Date.now が同一値でも seq サフィックスでユニークになる
    for (let i = 0; i < 5; i++) await logger.reportError(new Error(`e${i}`));
    expect(listReports()).toHaveLength(5);
  });

  it('上限（100件）を超えると古い順に刈られる', async () => {
    const dir = reportsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 既存 100 件 + 新規 1 件 → 最古 1 件が削除される
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(dir, `error-${1700000000000 + i}-x.json`), '{}');
    }
    await logger.reportError(new Error('new'));
    const files = listReports();
    expect(files).toHaveLength(100);
    expect(files.some(f => f.includes('error-1700000000000'))).toBe(false); // 最古が削除済み
    expect(files.some(f => f.includes('error-1700000000099'))).toBe(true);  // 最古より後は残る
  });
});
