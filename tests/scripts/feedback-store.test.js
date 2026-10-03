// tests/scripts/feedback-store.test.js
// scripts/lib/feedback-store.js（feedback パイプライン 4 本の共有読込み経路）の契約を固定する。
// - loadFeedback: 未作成→[]、破損/非配列→「どのファイルか」入りの例外（fail-closed）
// - normalizeEntry: フィールドの正規化（user 欠落→'(unknown)'、message 必須、timestamp 既定）
// - feedbackFilePath: FEEDBACK_LOG_PATH 差し替え

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFeedback, normalizeEntry, feedbackFilePath, DEFAULT_FEEDBACK_FILE } = require('../../scripts/lib/feedback-store');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-store-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadFeedback', () => {
  test('未作成ファイルは空配列（初回実行）', () => {
    expect(loadFeedback(path.join(tmp, 'none.json'))).toEqual([]);
  });

  test('破損 JSON はファイル名入りの例外（証跡上書き防止）', () => {
    const p = writeJson('bad.json', '[{"a":');
    expect(() => loadFeedback(p)).toThrow(/bad\.json/);
  });

  test('非配列は例外', () => {
    const p = writeJson('obj.json', '{"a":1}');
    expect(() => loadFeedback(p)).toThrow(/配列ではありません/);
  });

  test('不正エントリは除外し正常エントリのみ返す', () => {
    const p = writeJson('mix.json', JSON.stringify([
      { user: 'u', message: 'ok', timestamp: '2026-01-01T00:00:00Z' },
      null,
      'str',
      { user: 'u2' },            // message 無し → 除外
      { message: 'no-user' },    // user 無し → '(unknown)' で残る
    ]));
    const rows = loadFeedback(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].message).toBe('ok');
    expect(rows[1]).toMatchObject({ user: '(unknown)', message: 'no-user' });
  });
});

describe('normalizeEntry', () => {
  test('非オブジェクト・message 空は null', () => {
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry('x')).toBeNull();
    expect(normalizeEntry({ message: '   ' })).toBeNull();
    expect(normalizeEntry({})).toBeNull();
  });

  test('user 欠落・空白は "(unknown)" へ正規化', () => {
    expect(normalizeEntry({ message: 'm' }).user).toBe('(unknown)');
    expect(normalizeEntry({ message: 'm', user: '  ' }).user).toBe('(unknown)');
    expect(normalizeEntry({ message: 'm', user: 42 }).user).toBe('(unknown)');
  });

  test('message は非文字列を文字列化する', () => {
    expect(normalizeEntry({ message: 42 }).message).toBe('42');
    expect(normalizeEntry({ message: true }).message).toBe('true');
  });

  test('timestamp 欠落はエポックへ、非 ISO 文字列は透過する', () => {
    expect(normalizeEntry({ message: 'm' }).timestamp).toBe(new Date(0).toISOString());
    expect(normalizeEntry({ message: 'm', timestamp: 'さくせん' }).timestamp).toBe('さくせん');
  });

  test('他フィールドは透過する', () => {
    const row = normalizeEntry({ message: 'm', priority: 'high', extra: { a: 1 } });
    expect(row.priority).toBe('high');
    expect(row.extra).toEqual({ a: 1 });
  });
});

describe('feedbackFilePath', () => {
  test('既定は docs/feedback-log.json、env で差し替え可能', () => {
    delete process.env.FEEDBACK_LOG_PATH;
    expect(feedbackFilePath()).toBe(DEFAULT_FEEDBACK_FILE);
    process.env.FEEDBACK_LOG_PATH = '/tmp/custom.json';
    expect(feedbackFilePath()).toBe('/tmp/custom.json');
    delete process.env.FEEDBACK_LOG_PATH;
  });
});
