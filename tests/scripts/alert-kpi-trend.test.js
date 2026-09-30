// alert-kpi-trend.js の単体テスト
// 生成側が単一ファイル上書きのため、前回値はスクリプト自身の状態ファイルで比較する経路を検証。
const fs = require('fs');
const os = require('os');
const path = require('path');

const SENT = [];
jest.mock('../../scripts/slack-feedback-bot', () => ({
  sendSlackMessage: (msg) => { SENT.push(msg); },
}));

function writeReport(dir, name, { total = 10, done = 5, wip = 2, todo = 3 } = {}) {
  fs.writeFileSync(
    path.join(dir, name),
    `# KPIレポート\n- 総タスク数: ${total}\n- 完了: ${done}\n- 対応中: ${wip}\n- 未対応: ${todo}\n- 改善案数: 0\n`,
  );
}

function loadModule() {
  jest.resetModules();
  return require('../../scripts/alert-kpi-trend');
}

let reportDir;
let stateFile;
beforeEach(() => {
  reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-report-'));
  stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-state-')), 'state.json');
  process.env.KPI_REPORT_DIR = reportDir;
  process.env.KPI_STATE_FILE = stateFile;
  SENT.length = 0;
});
afterEach(() => {
  delete process.env.KPI_REPORT_DIR;
  delete process.env.KPI_STATE_FILE;
});

describe('alert-kpi-trend', () => {
  it('レポート不在時は警告せず終了し、状態を書かない', () => {
    const { alertKPITrend } = loadModule();
    const r = alertKPITrend();
    expect(r.reason).toBe('no-report');
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(SENT).toHaveLength(0);
  });

  it('初回実行は基準値を記録して通知しない', () => {
    writeReport(reportDir, 'checklist-kpi-report.md');
    const { alertKPITrend } = loadModule();
    const r = alertKPITrend();
    expect(r.reason).toBe('baseline');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.stats.total).toBe(10);
    expect(SENT).toHaveLength(0);
  });

  it('前回値から20%超の変動で Slack 通知する', () => {
    writeReport(reportDir, 'checklist-kpi-report.md', { todo: 3 });
    let m = loadModule();
    m.alertKPITrend(); // baseline
    writeReport(reportDir, 'checklist-kpi-report.md', { todo: 10 }); // +233%
    m = loadModule();
    const r = m.alertKPITrend();
    expect(r.alerted).toBe(true);
    expect(SENT).toHaveLength(1);
    expect(SENT[0]).toContain('todo');
  });

  it('変動が閾値未満なら通知しない', () => {
    writeReport(reportDir, 'checklist-kpi-report.md', { todo: 10 });
    let m = loadModule();
    m.alertKPITrend();
    writeReport(reportDir, 'checklist-kpi-report.md', { todo: 11 }); // +10%
    m = loadModule();
    const r = m.alertKPITrend();
    expect(r.alerted).toBe(false);
    expect(SENT).toHaveLength(0);
  });

  it('状態ファイルが破損していても基準値を取り直して継続する', () => {
    writeReport(reportDir, 'checklist-kpi-report.md');
    fs.writeFileSync(stateFile, '{{{corrupt');
    const { alertKPITrend } = loadModule();
    const r = alertKPITrend();
    expect(r.reason).toBe('baseline');
    expect(SENT).toHaveLength(0);
  });
});
