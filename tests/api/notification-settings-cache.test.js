// notification-settings.js の stat 指紋ゲート読み取りキャッシュ契約を固定。
// リクエスト毎の全文 readFileSync+JSON.parse (ホットパス同期 I/O) を避けるための
// キャッシュが、(a) 同一ファイルで参照を再利用し、(b) ファイル変更で再パースし、
// (c) 書き込み後の明示破棄で未コミット変更が残らないことを検証する。
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../../src/db/json/data-dir');

const SETTINGS_PATH = path.join(resolveDataDir(), 'notification-settings.json');
const { loadSettings, _invalidateSettingsCache } = require('../../src/api/notification-settings');

describe('notification-settings loadSettings cache', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ u1: { enabled: true } }));
    _invalidateSettingsCache();
  });
  afterEach(() => {
    _invalidateSettingsCache();
  });

  it('returns the same object while the file is unchanged', () => {
    const a = loadSettings();
    const b = loadSettings();
    expect(a).toBe(b);
  });

  it('re-parses when the file changes on disk', () => {
    const a = loadSettings();
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ u1: { enabled: false } }));
    // mtime が同一ミリ秒になり得るため明示的に進める
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(SETTINGS_PATH, future, future);
    const b = loadSettings();
    expect(b).not.toBe(a);
    expect(b.u1.enabled).toBe(false);
  });

  it('drops uncommitted mutation when the cache is invalidated', () => {
    const a = loadSettings();
    a.u1.enabled = false; // 書き込みパスの in-place 変更を模倣（ディスク未反映）
    _invalidateSettingsCache();
    const b = loadSettings();
    expect(b.u1.enabled).toBe(true); // ディスクの値が返る
  });

  it('throws on corrupt JSON instead of silently returning {}', () => {
    fs.writeFileSync(SETTINGS_PATH, '{ broken');
    _invalidateSettingsCache();
    expect(() => loadSettings()).toThrow();
  });
});
