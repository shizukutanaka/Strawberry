// tests/scripts/report-log-pii.test.js — report-log-pii.js の契約テスト。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { report, scanFile, credentialHits } = require('../../scripts/report-log-pii');

describe('report-log-pii', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('email 含む行を件数と行番号で検出する（値は収集しない）', () => {
    const f = path.join(tmpDir, 'app.log');
    fs.writeFileSync(f, 'line1 ok\nuser a@b.com logged in\nline3\nx@y.org z@w.net two\n');
    const r = scanFile(f);
    expect(r.hits).toBe(3);
    expect(r.hitLines).toEqual([2, 4]);
    expect(JSON.stringify(r)).not.toContain('a@b.com');
  });

  test('.log とローテーション .log.N を走査し他拡張子を除外する', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.log'), 'x@y.org\n');
    fs.writeFileSync(path.join(tmpDir, 'a.log.1'), 'x@y.org x@y.org\n');
    fs.writeFileSync(path.join(tmpDir, 'b.json'), 'x@y.org\n'); // 対象外
    const r = report(tmpDir);
    expect(r.files).toHaveLength(2);
    expect(r.files.find((f) => f.file === 'a.log').hits).toBe(1);
    expect(r.files.find((f) => f.file === 'a.log.1').hits).toBe(2);
  });

  test('email を含まないファイルは hits 0', () => {
    fs.writeFileSync(path.join(tmpDir, 'clean.log'), 'plain log line\n');
    const r = report(tmpDir);
    expect(r.files[0].hits).toBe(0);
  });

  test('不存在ディレクトリは error を返す', () => {
    const r = report(path.join(tmpDir, 'nope'));
    expect(r.error).toBeTruthy();
    expect(r.files).toEqual([]);
  });

  test('資格情報パターン（jwt/bearer/apikey）を種別集計する', () => {
    const f = path.join(tmpDir, 'creds.log');
    fs.writeFileSync(f, [
      'header ok',
      'token eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5cE seen',
      'auth Bearer AbCdEfGhIjKlMnOpQrSt1234 handled',
      'cfg api_key = "sk_live_abcdef123456789"',
    ].join('\n'));
    const r = scanFile(f);
    expect(r.byKind.jwt).toBe(1);
    expect(r.byKind.bearer).toBe(1);
    expect(r.byKind.apikey).toBe(1);
    expect(r.hits).toBe(3);
  });

  test('credentialHits は資格情報クラスのみ数え email を除外する（--strict のゲート対象）', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.log'), [
      'user a@b.com logged in',
      'token eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5cE',
      'plain line',
    ].join('\n'));
    const r = report(tmpDir);
    expect(credentialHits(r)).toBe(1);
    fs.writeFileSync(path.join(tmpDir, 'app.log'), 'user a@b.com logged in\n');
    expect(credentialHits(report(tmpDir))).toBe(0);
  });
});
