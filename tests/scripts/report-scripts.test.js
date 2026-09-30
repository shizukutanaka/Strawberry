// report 系 ops スクリプト（kpi-trend-graph / assignee-progress-report /
// checklist-kpi-report）の回帰テスト。
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-scripts-'));
});
afterEach(() => {
  delete process.env.KPI_REPORT_DIR;
  delete process.env.KPI_OUTPUT_PATH;
  delete process.env.FEEDBACK_PRIORITY_PATH;
  delete process.env.ASSIGNEE_REPORT_PATH;
  delete process.env.KPI_CHECKLIST_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('kpi-trend-graph.loadKPIHistory', () => {
  it('日付付き履歴が無くても最新 progress-report.md を拾う（生成側は日付なし出力）', () => {
    fs.writeFileSync(path.join(dir, 'progress-report.md'),
      '# レポート\n- 総フィードバック件数: 5\n- 完了: 2\n- 対応中: 1\n- 未対応: 2\n');
    process.env.KPI_REPORT_DIR = dir;
    jest.resetModules();
    const { loadKPIHistory } = require('../../scripts/kpi-trend-graph');
    const history = loadKPIHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ total: 5, done: 2, wip: 1, todo: 2 });
    expect(history[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('日付付き履歴と最新スナップショットを併用し日付順にソート', () => {
    fs.writeFileSync(path.join(dir, 'progress-report_2026-09-01.md'), '- 完了: 1\n');
    fs.writeFileSync(path.join(dir, 'progress-report.md'), '- 完了: 9\n');
    process.env.KPI_REPORT_DIR = dir;
    jest.resetModules();
    const { loadKPIHistory } = require('../../scripts/kpi-trend-graph');
    const history = loadKPIHistory();
    expect(history).toHaveLength(2);
    expect(history[0].date).toBe('2026-09-01');
    expect(history[1].done).toBe(9);
  });

  it('REPORT_DIR 不在・パース不能行で落ちない', () => {
    process.env.KPI_REPORT_DIR = path.join(dir, 'missing');
    jest.resetModules();
    const { loadKPIHistory } = require('../../scripts/kpi-trend-graph');
    expect(loadKPIHistory()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'progress-report.md'), '- 完了: notanum\n');
    jest.resetModules();
    expect(loadKPIHistory()).toEqual([]); // NaN 系列は捨て、kpi が空なら履歴に入れない
  });
});

describe('assignee-progress-report', () => {
  it('破損した feedback-priority.json はファイル名付き例外', () => {
    const p = path.join(dir, 'priority.json');
    fs.writeFileSync(p, '{ broken');
    process.env.FEEDBACK_PRIORITY_PATH = p;
    jest.resetModules();
    const { parseAssigneeProgress } = require('../../scripts/assignee-progress-report');
    expect(() => parseAssigneeProgress()).toThrow(/priority\.json.*破損/);
  });

  it('非文字列 status/assignee を正規化して集計する', () => {
    const p = path.join(dir, 'priority.json');
    fs.writeFileSync(p, JSON.stringify([
      { user: 'u1', message: 'a', status: '完了' },
      { user: 'u1', message: 'b', status: 42 },       // 非文字列 → 未対応
      { message: 'c', status: '対応中' },              // user 無し → 未割当
      'junk row',
    ]));
    process.env.FEEDBACK_PRIORITY_PATH = p;
    process.env.ASSIGNEE_REPORT_PATH = path.join(dir, 'report.md');
    jest.resetModules();
    const { parseAssigneeProgress } = require('../../scripts/assignee-progress-report');
    const users = parseAssigneeProgress();
    expect(users['u1']).toMatchObject({ 完了: 1, 未対応: 1 });
    expect(users['未割当']['対応中']).toBe(1);
  });

  it('Slack 通知失敗でもレポート生成は成功扱い', () => {
    const p = path.join(dir, 'priority.json');
    fs.writeFileSync(p, JSON.stringify([{ user: 'u', message: 'm', status: '完了' }]));
    process.env.FEEDBACK_PRIORITY_PATH = p;
    process.env.ASSIGNEE_REPORT_PATH = path.join(dir, 'report.md');
    jest.resetModules();
    // slack-feedback-bot の送信を失敗させる
    jest.doMock('../../scripts/slack-feedback-bot', () => ({
      sendSlackMessage: () => { throw new Error('slack down'); },
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { main } = require('../../scripts/assignee-progress-report');
    expect(() => main()).not.toThrow();
    expect(fs.existsSync(process.env.ASSIGNEE_REPORT_PATH)).toBe(true);
    jest.dontMock('../../scripts/slack-feedback-bot');
  });
});

describe('checklist-kpi-report', () => {
  it('チェックリスト不在ならファイル名付きの明示エラー', () => {
    process.env.KPI_CHECKLIST_PATH = path.join(dir, 'missing.md');
    jest.resetModules();
    const { parseChecklist } = require('../../scripts/checklist-kpi-report');
    expect(() => parseChecklist()).toThrow(/missing\.md.*ありません/);
  });

  it('チェックボックス状態と改善案カテゴリを集計する', () => {
    const file = path.join(dir, 'cl.md');
    fs.writeFileSync(file, '- [x] done\n- [-] wip\n- [ ] todo\n- 【改善案】監視。説明\n');
    process.env.KPI_CHECKLIST_PATH = file;
    jest.resetModules();
    const { parseChecklist, renderReport } = require('../../scripts/checklist-kpi-report');
    const stat = parseChecklist();
    expect(stat).toMatchObject({ total: 3, done: 1, wip: 1, todo: 1, improvements: 1 });
    expect(renderReport(stat)).toContain('監視');
  });
});
