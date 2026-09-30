// src/security-audit.js の npm audit 実行オプションと結果処理の回帰テスト。
// exec に timeout/maxBuffer が無いと、npm のハングで監視プロセスが永久滞留し、
// 脆弱性多数時の大きな JSON が 1MB で切断されて「パース失敗」だけが記録され続ける。
jest.mock('child_process', () => ({ exec: jest.fn() }));

const { exec } = require('child_process');
const fs = require('fs');
const { runNpmAudit } = require('../src/security-audit');

function auditLogEvents() {
  return fs.appendFileSync.mock.calls.map(([, line]) => JSON.parse(line));
}

describe('security-audit runNpmAudit', () => {
  let appendSpy;
  let mkdirSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  });
  afterEach(() => {
    appendSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it('exec にタイムアウトと十分な maxBuffer を渡す', () => {
    exec.mockImplementation(() => {});
    runNpmAudit();
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, opts] = exec.mock.calls[0];
    expect(cmd).toBe('npm audit --json');
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.maxBuffer).toBeGreaterThan(1024 * 1024); // 既定 1MB では切断しうる
  });

  it('脆弱性あり（exit 1 でも stdout の JSON は有効）→ VULN_FOUND を記録', () => {
    exec.mockImplementation((cmd, opts, cb) => {
      const err = new Error('exit 1');
      err.code = 1;
      cb(err, JSON.stringify({ metadata: { vulnerabilities: { total: 3 } } }), '');
    });
    runNpmAudit();
    const events = auditLogEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('VULN_FOUND');
    expect(events[0].vulnerabilities.total).toBe(3);
  });

  it('脆弱性なし → NO_VULN を記録', () => {
    exec.mockImplementation((cmd, opts, cb) => {
      cb(null, JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }), '');
    });
    runNpmAudit();
    expect(auditLogEvents()[0].type).toBe('NO_VULN');
  });

  it('タイムアウト/切断（不正 JSON）→ 原因情報付き AUDIT_ERROR を記録', () => {
    exec.mockImplementation((cmd, opts, cb) => {
      const err = new Error('maxBuffer exceeded');
      cb(err, '{"metadata":{"vulnerab', '');
    });
    runNpmAudit();
    const ev = auditLogEvents()[0];
    expect(ev.type).toBe('AUDIT_ERROR');
    expect(ev.execError).toMatch(/maxBuffer/);
  });
});
