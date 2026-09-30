// alert-* スクリプト（Slack アラート通知）の共有部品と各通知関数のテスト
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir;
let sent;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-scripts-'));
  sent = [];
  jest.resetModules();
  jest.doMock('../../scripts/slack-feedback-bot', () => ({
    sendSlackMessage: text => sent.push(text),
  }));
});
afterEach(() => {
  delete process.env.FEEDBACK_PRIORITY_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
  jest.dontMock('../../scripts/slack-feedback-bot');
  jest.restoreAllMocks();
});

function writePriority(entries) {
  const p = path.join(dir, 'feedback-priority.json');
  fs.writeFileSync(p, JSON.stringify(entries));
  process.env.FEEDBACK_PRIORITY_PATH = p;
}

describe('lib/alert-common', () => {
  it('優先度ファイル未作成なら空配列、破損・非配列は明示エラー', () => {
    process.env.FEEDBACK_PRIORITY_PATH = path.join(dir, 'none.json');
    const { loadPriorityFeedback } = require('../../scripts/lib/alert-common');
    expect(loadPriorityFeedback()).toEqual([]);

    fs.writeFileSync(process.env.FEEDBACK_PRIORITY_PATH, '{ broken');
    expect(() => loadPriorityFeedback()).toThrow(/none\.json.*破損/);

    fs.writeFileSync(process.env.FEEDBACK_PRIORITY_PATH, '{"a":1}');
    expect(() => loadPriorityFeedback()).toThrow(/配列ではありません/);
  });

  it('非オブジェクト要素を除去し、期限フィールドは既知キーを順に参照する', () => {
    writePriority(['junk', null, { due: '2000-01-01' }, { deadline: '2000-01-02' }, { 期限: '2000-01-03' }]);
    const { loadPriorityFeedback, isOverdue, dueOf } = require('../../scripts/lib/alert-common');
    const rows = loadPriorityFeedback();
    expect(rows).toHaveLength(3);
    expect(rows.map(dueOf)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03']);
    expect(isOverdue('2000-01-01')).toBe(true);
    expect(isOverdue('2999-01-01')).toBe(false);
    expect(isOverdue('invalid')).toBe(false);
    expect(isOverdue(undefined)).toBe(false);
  });

  it('sendAlert は長いリストを分割して送信する', () => {
    const { sendAlert } = require('../../scripts/lib/alert-common');
    const many = Array.from({ length: 80 }, (_, i) => ({ user: 'u', message: 'x'.repeat(80) + i }));
    sendAlert('【T】テスト', many);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every(c => c.length <= 3100)).toBe(true);
  });
});

describe('alert-* 通知関数', () => {
  it('alertHighPriority: 高優先度×未対応のみ通知', () => {
    writePriority([
      { user: 'u', message: 'hi', priority: '高', status: '未対応' },
      { user: 'u', message: 'done', priority: '高', status: '完了' },
      { user: 'u', message: 'low', priority: '低', status: '未対応' },
    ]);
    const { alertHighPriority } = require('../../scripts/alert-high-priority');
    expect(alertHighPriority()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('hi');
    expect(sent[0]).not.toContain('done');
  });

  it('alertOverdue: 期限切れのみ通知', () => {
    writePriority([
      { user: 'u', message: 'old', due: '2000-01-01' },
      { user: 'u', message: 'future', due: '2999-01-01' },
      { user: 'u', message: 'nodate' },
    ]);
    const { alertOverdue } = require('../../scripts/alert-overdue');
    expect(alertOverdue()).toBe(1);
    expect(sent[0]).toContain('old');
  });

  it('alertOverdueHigh: 期限切れ AND 高優先度のみ通知、該当無しなら送信しない', () => {
    writePriority([
      { user: 'u', message: 'a', priority: '高', due: '2000-01-01' },
      { user: 'u', message: 'b', priority: '中', due: '2000-01-01' },
      { user: 'u', message: 'c', priority: '高', due: '2999-01-01' },
    ]);
    const { alertOverdueHigh } = require('../../scripts/alert-overdue-high');
    expect(alertOverdueHigh()).toBe(1);
    expect(sent[0]).toContain('a');
    expect(sent[0]).not.toContain('b');

    sent = [];
    writePriority([{ user: 'u', message: 'ok', priority: '中', due: '2999-01-01' }]);
    jest.resetModules();
    jest.doMock('../../scripts/slack-feedback-bot', () => ({ sendSlackMessage: t => sent.push(t) }));
    const { alertOverdueHigh: again } = require('../../scripts/alert-overdue-high');
    expect(again()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
