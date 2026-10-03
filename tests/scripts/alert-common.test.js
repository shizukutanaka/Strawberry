// tests/scripts/alert-common.test.js
// scripts/lib/alert-common.js（alert-* 3本が共有する期限アラート部品）の契約を固定する。
// - loadPriorityFeedback: 未作成→[]、破損/非配列→「どのファイルか」入りの例外
//   （サイレントに空扱いするとアラートが静かに止まるため fail-closed）
// - isOverdue/dueOf/formatEntry: 期限解釈とメッセージ整形
// - sendAlert: Slack 分割送信（3000文字チャンク）と件数返却

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../scripts/slack-feedback-bot', () => ({ sendSlackMessage: jest.fn() }));

const { sendSlackMessage } = require('../../scripts/slack-feedback-bot');
const { loadPriorityFeedback, isOverdue, dueOf, formatEntry, sendAlert } = require('../../scripts/lib/alert-common');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-common-'));
  sendSlackMessage.mockReset();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadPriorityFeedback', () => {
  test('未作成ファイルは空配列を返す（初回実行・CI クリーン環境）', () => {
    expect(loadPriorityFeedback(path.join(tmp, 'missing.json'))).toEqual([]);
  });

  test('破損ファイルはファイル名入りの例外を投げる（サイレント停止防止）', () => {
    const p = writeJson('bad.json', '{ not json');
    expect(() => loadPriorityFeedback(p)).toThrow(/bad\.json/);
  });

  test('非配列（オブジェクト等）は例外を投げる', () => {
    const p = writeJson('obj.json', '{"a":1}');
    expect(() => loadPriorityFeedback(p)).toThrow(/配列ではありません/);
  });

  test('配列から null/プリミティブを除去して返す', () => {
    const p = writeJson('ok.json', JSON.stringify([{ message: 'x' }, null, 'str', 42, { message: 'y' }]));
    expect(loadPriorityFeedback(p)).toEqual([{ message: 'x' }, { message: 'y' }]);
  });
});

describe('isOverdue', () => {
  test('期限なし・不正日付は false（アラートしない）', () => {
    expect(isOverdue(undefined)).toBe(false);
    expect(isOverdue('not-a-date')).toBe(false);
    expect(isOverdue('')).toBe(false);
  });

  test('過去は true・未来は false', () => {
    expect(isOverdue('2000-01-01')).toBe(true);
    expect(isOverdue('2999-01-01')).toBe(false);
  });
});

describe('dueOf', () => {
  test('既知キーを優先順位（due > deadline > 期限 > date）で解決する', () => {
    expect(dueOf({ due: 'D', deadline: 'L', '期限': 'K', date: 'A' })).toBe('D');
    expect(dueOf({ deadline: 'L', '期限': 'K', date: 'A' })).toBe('L');
    expect(dueOf({ '期限': 'K', date: 'A' })).toBe('K');
    expect(dueOf({ date: 'A' })).toBe('A');
    expect(dueOf({})).toBeUndefined();
  });
});

describe('formatEntry', () => {
  test('期限・timestamp・user・message を1行へ畳み、空白を正規化する', () => {
    const s = formatEntry({ due: '2026-01-01', timestamp: 't1', user: 'u1', message: ' m  ' });
    expect(s).toBe('- 2026-01-01 t1 u1: m');
  });

  test('欠落フィールドは省略される', () => {
    expect(formatEntry({ message: 'only' })).toBe('- only');
  });
});

describe('sendAlert', () => {
  test('件数込みタイトル付きで送信しチャンク数を返す', () => {
    const n = sendAlert('期限切れ', [{ message: 'a' }, { message: 'b' }]);
    expect(n).toBe(1);
    expect(sendSlackMessage).toHaveBeenCalledTimes(1);
    const sent = sendSlackMessage.mock.calls[0][0];
    expect(sent).toContain('期限切れが2件あります');
    expect(sent).toContain('- a');
    expect(sent).toContain('- b');
  });

  test('3000文字を超えると分割して送信する', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ message: 'x'.repeat(80) + i }));
    const n = sendAlert('T', entries);
    expect(n).toBeGreaterThan(1);
    expect(sendSlackMessage).toHaveBeenCalledTimes(n);
    for (const [arg] of sendSlackMessage.mock.calls) {
      expect(arg.length).toBeLessThanOrEqual(3200); // 3000 閾値 + 1 行
    }
  });
});
