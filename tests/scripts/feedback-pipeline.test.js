// scripts/lib/feedback-store.js + feedback-* スクリプトの回帰テスト。
// 旧実装は各スクリプトが独自に JSON.parse(readFileSync) しており、破損ログで
// 全段が無情報クラッシュ・非文字列フィールドで TypeError・require 副作用で
// ファイルを書き込む（report/checklist）問題を持っていた。
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
let logPath;

function seed(entries) {
  fs.writeFileSync(logPath, JSON.stringify(entries));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-pipe-'));
  logPath = path.join(dir, 'feedback-log.json');
  process.env.FEEDBACK_LOG_PATH = logPath;
});
afterEach(() => {
  delete process.env.FEEDBACK_LOG_PATH;
  delete process.env.FEEDBACK_PRIORITY_PATH;
  delete process.env.FEEDBACK_CHECKLIST_PATH;
  delete process.env.FEEDBACK_REPORT_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('feedback-store.loadFeedback', () => {
  it('ファイル不在なら空配列', () => {
    jest.resetModules();
    const { loadFeedback } = require('../../scripts/lib/feedback-store');
    expect(loadFeedback()).toEqual([]);
  });

  it('破損 JSON はファイル名を含む例外になる（空配列で誤魔化さない）', () => {
    fs.writeFileSync(logPath, '{ broken');
    jest.resetModules();
    const { loadFeedback } = require('../../scripts/lib/feedback-store');
    expect(() => loadFeedback()).toThrow(/feedback-log\.json.*破損/);
  });

  it('非配列 JSON は処理中止の例外', () => {
    fs.writeFileSync(logPath, '{"a":1}');
    jest.resetModules();
    const { loadFeedback } = require('../../scripts/lib/feedback-store');
    expect(() => loadFeedback()).toThrow(/配列ではありません/);
  });

  it('不正フィールドを正規化して返す（旧ログの非文字列で落ちない）', () => {
    seed([
      { user: 'a', message: 'ok', timestamp: '2026-09-01T00:00:00Z' },
      { user: null, message: 42, timestamp: undefined }, // 旧ログ混入
      'not an object',
      { user: 'b', message: '', timestamp: 'x' }, // 空メッセージは捨てる
    ]);
    jest.resetModules();
    const { loadFeedback } = require('../../scripts/lib/feedback-store');
    const log = loadFeedback();
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('ok');
    expect(log[1].message).toBe('42');
    expect(log[1].user).toBe('(unknown)');
    expect(typeof log[1].timestamp).toBe('string');
  });
});

describe('feedback-priority.labelFeedback', () => {
  it('優先度ラベルを付けてアトミックに書き出す（非文字列でも落ちない）', () => {
    seed([
      { user: 'a', message: 'サーバーが停止した', timestamp: '2026-09-20T00:00:00Z' },
      { user: 'b', message: 'UIが遅い', timestamp: '2026-09-21T00:00:00Z' },
      { user: 'c', message: 'ありがとう', timestamp: '2026-09-22T00:00:00Z' },
    ]);
    process.env.FEEDBACK_PRIORITY_PATH = path.join(dir, 'priority.json');
    jest.resetModules();
    const { labelFeedback } = require('../../scripts/feedback-priority');
    const labeled = labelFeedback();
    expect(labeled.map(l => l.priority)).toEqual(['高', '中', '低']);
    expect(JSON.parse(fs.readFileSync(process.env.FEEDBACK_PRIORITY_PATH, 'utf8'))).toHaveLength(3);
  });
});

describe('feedback-to-checklist.appendChecklist', () => {
  it('チェックリスト不在でも新規作成して反映する', () => {
    process.env.FEEDBACK_CHECKLIST_PATH = path.join(dir, 'checklist.md');
    jest.resetModules();
    const { appendChecklist } = require('../../scripts/feedback-to-checklist');
    const out = appendChecklist([{ user: 'a', message: 'm1', timestamp: '2026-09-01T00:00:00Z' }]);
    expect(out).toContain('AUTO_FEEDBACK_CHECKLIST');
    expect(fs.readFileSync(process.env.FEEDBACK_CHECKLIST_PATH, 'utf8')).toContain('a: m1');
  });

  it('既存セクションをマーカー内で置換する（重複追記しない）', () => {
    const file = path.join(dir, 'checklist.md');
    fs.writeFileSync(file, '# Head\n<!-- AUTO_FEEDBACK_CHECKLIST -->\nold\n<!-- AUTO_FEEDBACK_CHECKLIST -->\n');
    process.env.FEEDBACK_CHECKLIST_PATH = file;
    jest.resetModules();
    const { appendChecklist } = require('../../scripts/feedback-to-checklist');
    const out = appendChecklist([{ user: 'x', message: 'new', timestamp: '2026-09-02T00:00:00Z' }]);
    expect(out).toContain('new');
    expect(out).not.toContain('old');
    expect(fs.readFileSync(file, 'utf8')).toContain('# Head');
  });
});

describe('feedback-report', () => {
  it('require しても副作用で書き込まない（require.main ガード）', () => {
    process.env.FEEDBACK_REPORT_PATH = path.join(dir, 'report.md');
    jest.resetModules();
    require('../../scripts/feedback-report');
    expect(fs.existsSync(process.env.FEEDBACK_REPORT_PATH)).toBe(false);
  });

  it('直近7日のエントリだけを集計し、不正 timestamp は除外する', () => {
    const now = Date.now();
    seed([
      { user: 'a', message: 'recent', timestamp: new Date(now - 86400000).toISOString() },
      { user: 'b', message: 'old', timestamp: new Date(now - 30 * 86400000).toISOString() },
      { user: 'c', message: 'bad-ts', timestamp: 'not-a-date' },
    ]);
    process.env.FEEDBACK_REPORT_PATH = path.join(dir, 'report.md');
    jest.resetModules();
    const { aggregateFeedback, generateReport } = require('../../scripts/feedback-report');
    const fb = aggregateFeedback();
    expect(fb.map(f => f.message)).toEqual(['recent']);
    expect(generateReport(fb)).toContain('recent');
    expect(generateReport([])).toContain('ありません');
  });
});
