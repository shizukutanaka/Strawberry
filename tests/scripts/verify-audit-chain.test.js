// tests/scripts/verify-audit-chain.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { verify, hashPathFor } = require('../../scripts/verify-audit-chain');

function writeChain(dir, lines) {
  const logPath = path.join(dir, 'audit.log');
  fs.writeFileSync(logPath, lines.map((l) => l + '\n').join(''));
  let prev = '';
  for (const line of lines) {
    prev = crypto.createHash('sha256').update(prev + line).digest('hex');
  }
  const hashPath = path.join(dir, 'audit.hash');
  fs.writeFileSync(hashPath, prev);
  return { logPath, hashPath };
}

const entry = (action) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', action, detail: {}, user: 'system' });

describe('verify-audit-chain', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditchain-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('正しい連鎖は match=true', () => {
    const { logPath } = writeChain(dir, [entry('a'), entry('b'), entry('c')]);
    const r = verify(logPath);
    expect(r.match).toBe(true);
    expect(r.lines).toBe(3);
    expect(r.malformedLines).toHaveLength(0);
    expect(r.error).toBeNull();
  });

  it('途中の行を改竄すると match=false', () => {
    const { logPath } = writeChain(dir, [entry('a'), entry('b')]);
    const raw = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    raw[1] = entry('tampered');
    fs.writeFileSync(logPath, raw.join('\n') + '\n');
    const r = verify(logPath);
    expect(r.match).toBe(false);
    expect(r.storedHash).not.toBe(r.recomputedHash);
  });

  it('hash ファイル自体の改竄も検出する', () => {
    const { logPath, hashPath } = writeChain(dir, [entry('a')]);
    fs.writeFileSync(hashPath, '0'.repeat(64));
    const r = verify(logPath);
    expect(r.match).toBe(false);
  });

  it('形式外の行を malformedLines で報告する（行番号）', () => {
    const { logPath } = writeChain(dir, [entry('ok'), 'not-json', '{"x":1}']);
    const r = verify(logPath);
    expect(r.malformedLines).toEqual([2, 3]);
    // 形式外行自体は連鎖に含まれるので match は連鎖が正しければ true
    expect(r.match).toBe(true);
  });

  it('ログファイル欠落で error を返す', () => {
    const r = verify(path.join(dir, 'missing.log'));
    expect(r.error).toBe('log file not found');
    expect(r.match).toBe(false);
  });

  it('hash ファイル欠落で error を返す', () => {
    const logPath = path.join(dir, 'audit.log');
    fs.writeFileSync(logPath, entry('a') + '\n');
    const r = verify(logPath);
    expect(r.error).toBe('hash file not found');
  });

  it('空ログは連鎖一致（両方空ハッシュ扱い）', () => {
    const { logPath } = writeChain(dir, []);
    const r = verify(logPath);
    expect(r.lines).toBe(0);
    expect(r.match).toBe(true);
  });

  it('hashPathFor は .log→.hash 規約と AUDIT_HASH_PATH 上書きに従う', () => {
    expect(hashPathFor('/x/y/audit.log')).toBe('/x/y/audit.hash');
    expect(hashPathFor('/x/y/custom.txt')).toBe('/x/y/custom.txt.hash');
    process.env.AUDIT_HASH_PATH = '/tmp/override.hash';
    expect(hashPathFor('/x/y/audit.log')).toBe('/tmp/override.hash');
    delete process.env.AUDIT_HASH_PATH;
  });
});
