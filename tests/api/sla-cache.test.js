// tests/api/sla-cache.test.js — /sla・/anomalies の stat 指紋キャッシュ契約 (i7)
// 旧実装はリクエスト毎に全文 readFileSync+JSON.parse していた（ホットパス同期 I/O）。
// stat 指紋で「変わった時だけ再パース」になることを契約として固定する。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _testInternals } = require('../../src/api/sla.js');
const { loadJsonCached, _cache } = _testInternals;

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('同一指紋では再パースせずキャッシュを返す', () => {
  const f = path.join(dir, 'sla.json');
  fs.writeFileSync(f, JSON.stringify({ up: 9, down: 1, total: 10 }));
  const a = loadJsonCached(f);
  expect(a.total).toBe(10);
  const hit = _cache.get(f);
  expect(hit).toBeTruthy();
  // 2回目: stat は変わらないので同一オブジェクト参照が返る
  const b = loadJsonCached(f);
  expect(b).toBe(a);
});

it('ファイル変更で指紋が変わり再パースする', () => {
  const f = path.join(dir, 'sla.json');
  fs.writeFileSync(f, JSON.stringify({ total: 1 }));
  const a = loadJsonCached(f);
  // mtime を進めて指紋を変える（内容変更だけだと mtime 粒度で同一指紋になり得る）
  fs.writeFileSync(f, JSON.stringify({ total: 99, extra: 'pad-to-change-size' }));
  const b = loadJsonCached(f);
  expect(b.total).toBe(99);
  expect(b).not.toBe(a);
});

it('不存在ファイルは null、破損 JSON も null でキャッシュされない', () => {
  const missing = path.join(dir, 'nope.json');
  expect(loadJsonCached(missing)).toBe(null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{broken');
  expect(loadJsonCached(bad)).toBe(null);
  expect(_cache.has(bad)).toBe(false);
  // 修復すれば次回で回復する
  fs.writeFileSync(bad, JSON.stringify({ ok: 1 }));
  expect(loadJsonCached(bad).ok).toBe(1);
});
