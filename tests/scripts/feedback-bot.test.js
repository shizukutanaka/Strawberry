// scripts/feedback-bot.js の回帰テスト。
// 旧実装は (1) JSON.parse にガードが無く破損ログで以降全投稿がクラッシュ、
// (2) fs.writeFileSync の非アトミック書込みで中断時にログが半壊、
// (3) user/message の型・長さ検証なし、の3点を持っていた。
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadFreshBot(logPath) {
  process.env.FEEDBACK_LOG_PATH = logPath;
  jest.resetModules();
  return require('../../scripts/feedback-bot');
}

describe('feedback-bot submitFeedback', () => {
  let dir;
  let logPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-bot-'));
    logPath = path.join(dir, 'feedback-log.json');
  });
  afterEach(() => {
    delete process.env.FEEDBACK_LOG_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('新規ファイルにエントリを追記する', () => {
    const { submitFeedback } = loadFreshBot(logPath);
    submitFeedback({ user: 'alice', message: 'UI が遅い' });
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ user: 'alice', message: 'UI が遅い' });
    expect(log[0].timestamp).toBeTruthy();
  });

  it('既存ログに追記する（既存エントリを保持）', () => {
    fs.writeFileSync(logPath, JSON.stringify([{ user: 'old', message: '既存', timestamp: 'x' }]));
    const { submitFeedback } = loadFreshBot(logPath);
    submitFeedback({ user: 'bob', message: '追加' });
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(log).toHaveLength(2);
    expect(log[0].user).toBe('old');
    expect(log[1].user).toBe('bob');
  });

  it('破損した既存ログを退避して新規開始する（以降の投稿がクラッシュしない）', () => {
    fs.writeFileSync(logPath, '{ broken json !!!');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { submitFeedback } = loadFreshBot(logPath);
    submitFeedback({ user: 'carol', message: '再開できる' });
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    expect(log).toHaveLength(1);
    expect(log[0].user).toBe('carol');
    // 破損ファイルは消去ではなく退避される
    const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('feedback-log.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('配列でない既存 JSON は上書きせず例外にする', () => {
    fs.writeFileSync(logPath, '{"unexpected": true}');
    const { submitFeedback } = loadFreshBot(logPath);
    expect(() => submitFeedback({ user: 'dave', message: 'x' })).toThrow(/not an array/);
    // 既存ファイルが改変されていない
    expect(JSON.parse(fs.readFileSync(logPath, 'utf8'))).toEqual({ unexpected: true });
  });

  it('user/message のバリデーション（空・非文字列・超長を拒否）', () => {
    const { submitFeedback } = loadFreshBot(logPath);
    expect(() => submitFeedback({ user: '', message: 'x' })).toThrow(/user/);
    expect(() => submitFeedback({ user: 'a'.repeat(200), message: 'x' })).toThrow(/user/);
    expect(() => submitFeedback({ user: 'ok', message: '' })).toThrow(/message/);
    expect(() => submitFeedback({ user: 'ok', message: 'y'.repeat(5000) })).toThrow(/message/);
    expect(() => submitFeedback({ user: 'ok', message: 42 })).toThrow(/message/);
    expect(fs.existsSync(logPath)).toBe(false); // 何も書かれていない
  });
});
