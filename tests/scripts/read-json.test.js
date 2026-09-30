// tests/scripts/read-json.test.js
// scripts/lib/read-json.js の堅牢化を直接検証する。
// docs/ 以下の ops JSON が破損・未作成でも cron/パイプラインを殺さないことを固定。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonFile, readJsonArray } = require('../../scripts/lib/read-json');

describe('readJsonFile', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.warn.mockRestore();
  });

  it('parses a valid JSON file', () => {
    const p = path.join(dir, 'ok.json');
    fs.writeFileSync(p, '{"a":1}');
    expect(readJsonFile(p)).toEqual({ a: 1 });
  });

  it('returns undefined on missing file without warning', () => {
    expect(readJsonFile(path.join(dir, 'missing.json'))).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns undefined and warns on corrupted JSON', () => {
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{broken');
    expect(readJsonFile(p)).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('readJsonArray', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-arr-'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.warn.mockRestore();
  });

  it('returns the array for a valid array file', () => {
    const p = path.join(dir, 'arr.json');
    fs.writeFileSync(p, '[{"priority":"高"}]');
    expect(readJsonArray(p)).toEqual([{ priority: '高' }]);
  });

  it('returns [] for non-array JSON (object/scalar) — .filter stays safe', () => {
    for (const content of ['{}', '"x"', '42', 'null']) {
      const p = path.join(dir, `f-${content.length}.json`);
      fs.writeFileSync(p, content);
      expect(readJsonArray(p)).toEqual([]);
    }
  });

  it('returns [] for missing and corrupted files', () => {
    expect(readJsonArray(path.join(dir, 'nope.json'))).toEqual([]);
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '[{,]');
    expect(readJsonArray(p)).toEqual([]);
  });
});
