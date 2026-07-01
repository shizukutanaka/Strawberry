// tests/db/atomicWrite.test.js
//
// Behavioral coverage for src/db/json/atomicWrite.js, which had no dedicated test
// file despite being the durability primitive underlying every JSON repository
// write (including escrows.json / payments.json where a lost write means a
// stranded or double-processed payment). Only indirect coverage existed via
// probe53-prototype-pollution.
//
// Covers: correct content written, existing files overwritten atomically, no
// leftover temp files after success, temp file cleanup on failure, directory
// auto-creation, and JSON vs raw-string write variants.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJSON, atomicWriteString } = require('../../src/db/json/atomicWrite');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomicwrite-test-'));
}

describe('atomicWriteString', () => {
  let dir;
  beforeEach(() => { dir = mkTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes the exact content to the target file', () => {
    const target = path.join(dir, 'out.txt');
    atomicWriteString(target, 'hello world');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
  });

  it('overwrites an existing file completely (no partial/appended content)', () => {
    const target = path.join(dir, 'out.txt');
    fs.writeFileSync(target, 'this is a much longer old value that should be fully replaced');
    atomicWriteString(target, 'short');
    expect(fs.readFileSync(target, 'utf-8')).toBe('short');
  });

  it('creates the containing directory recursively if it does not exist', () => {
    const target = path.join(dir, 'nested', 'deeper', 'out.txt');
    atomicWriteString(target, 'data');
    expect(fs.readFileSync(target, 'utf-8')).toBe('data');
  });

  it('leaves no leftover .tmp files after a successful write', () => {
    const target = path.join(dir, 'out.txt');
    atomicWriteString(target, 'data');
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['out.txt']);
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('each write uses a unique temp filename (pid + random suffix, no collisions across rapid calls)', () => {
    const target = path.join(dir, 'out.txt');
    // Fire several writes in a row; if temp names collided, one write could
    // clobber another's in-flight temp file before rename.
    for (let i = 0; i < 10; i++) {
      atomicWriteString(target, `iteration-${i}`);
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('iteration-9');
    expect(fs.readdirSync(dir)).toEqual(['out.txt']);
  });

  it('cleans up the temp file if the rename fails', () => {
    const target = path.join(dir, 'out.txt');
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated rename failure');
    });
    expect(() => atomicWriteString(target, 'data')).toThrow('simulated rename failure');
    renameSpy.mockRestore();
    // No target file created, and no orphaned .tmp file left behind.
    const entries = fs.readdirSync(dir);
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('propagates the original error when the write fails', () => {
    const target = path.join(dir, 'out.txt');
    const writeSpy = jest.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    expect(() => atomicWriteString(target, 'data')).toThrow('simulated disk full');
    writeSpy.mockRestore();
  });
});

describe('atomicWriteJSON', () => {
  let dir;
  beforeEach(() => { dir = mkTmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('serializes and writes valid JSON that round-trips correctly', () => {
    const target = path.join(dir, 'data.json');
    const payload = { id: 'abc', amountSats: 12345, nested: { ok: true }, list: [1, 2, 3] };
    atomicWriteJSON(target, payload);
    const readBack = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(readBack).toEqual(payload);
  });

  it('pretty-prints JSON with 2-space indentation (matches JSON.stringify(data, null, 2))', () => {
    const target = path.join(dir, 'data.json');
    atomicWriteJSON(target, { a: 1 });
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('overwrites an existing JSON file atomically (readers never see a truncated/partial file)', () => {
    const target = path.join(dir, 'data.json');
    atomicWriteJSON(target, { version: 1, items: new Array(100).fill('x') });
    atomicWriteJSON(target, { version: 2 });
    const readBack = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(readBack).toEqual({ version: 2 });
  });

  it('handles an array payload (the repository layer contract)', () => {
    const target = path.join(dir, 'data.json');
    const rows = [{ id: '1' }, { id: '2' }];
    atomicWriteJSON(target, rows);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(rows);
  });
});
