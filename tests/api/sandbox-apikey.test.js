// tests/api/sandbox-apikey.test.js
// sandbox-apikey.js の直接ユニットテスト。
// 開発/テスト専用の API キー発行・検証 — generateApiKey の形式と isValidApiKey の
// 動作を固定する。
const os = require('os');
const path = require('path');
const fs = require('fs');
const { atomicWriteJSON } = require('../../src/db/json/atomicWrite');
const { resolveDataDir } = require('../../src/db/json/data-dir');

const KEY_PATH = path.join(resolveDataDir(), 'sandbox-apikeys.json');
const { generateApiKey, isValidApiKey } = require('../../src/api/sandbox-apikey');

describe('sandbox-apikey', () => {
  let saved;
  beforeAll(() => {
    saved = fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH) : null;
  });
  afterAll(() => {
    if (saved === null) {
      try { fs.unlinkSync(KEY_PATH); } catch {}
    } else {
      fs.writeFileSync(KEY_PATH, saved);
    }
  });
  beforeEach(() => {
    // 空のキーリストへリセット
    atomicWriteJSON(KEY_PATH, []);
  });

  it('generateApiKey は 48hex 文字列を返す（24 バイト）', () => {
    const k = generateApiKey();
    expect(k).toMatch(/^[0-9a-f]{48}$/);
  });

  it('連続呼出しで異なるキー（crypto.randomBytes）', () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });

  it('isValidApiKey: 存在しないキーは false', () => {
    expect(isValidApiKey('deadbeef'.repeat(6))).toBe(false);
  });

  it('isValidApiKey: 永続化されたキーは true', () => {
    const k = generateApiKey();
    atomicWriteJSON(KEY_PATH, [{ userId: 'u1', key: k, created: new Date().toISOString() }]);
    expect(isValidApiKey(k)).toBe(true);
    expect(isValidApiKey(k.slice(0, -2) + '00')).toBe(false);
  });

  it('破損/不在のキーファイルはクラッシュせず false', () => {
    fs.writeFileSync(KEY_PATH, '{broken');
    expect(isValidApiKey('x')).toBe(false);
    fs.unlinkSync(KEY_PATH);
    expect(isValidApiKey('x')).toBe(false);
  });
});
