// tests/security/probe53-prototype-pollution.test.js
// Probe 53 regression tests (Qiita/Zenn prototype-pollution review):
// The JSON repository factory is the single write chokepoint for all 7 repos.
// stripDangerousKeys() removes __proto__/constructor/prototype keys from records
// before they are spread/merged and persisted to data/*.json, so a malicious key
// from JSON.parse can never be written to disk (defense-in-depth, independent of
// upstream Joi validation).

const fs = require('fs');
const path = require('path');
const { createJsonRepository, stripDangerousKeys } = require('../../src/db/json/createJsonRepository');

describe('stripDangerousKeys', () => {
  it('removes __proto__/constructor/prototype own keys (from JSON.parse)', () => {
    const malicious = JSON.parse('{"a":1,"__proto__":{"isAdmin":true},"constructor":{"x":1},"prototype":{"y":2}}');
    const cleaned = stripDangerousKeys(malicious);
    expect(Object.prototype.hasOwnProperty.call(cleaned, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned, 'prototype')).toBe(false);
    expect(cleaned.a).toBe(1); // legitimate fields preserved
  });

  it('returns non-object inputs unchanged', () => {
    expect(stripDangerousKeys(null)).toBeNull();
    expect(stripDangerousKeys(42)).toBe(42);
    expect(stripDangerousKeys('x')).toBe('x');
  });

  it('does not allocate a copy when there is nothing to strip (identity)', () => {
    const clean = { a: 1, b: 2 };
    expect(stripDangerousKeys(clean)).toBe(clean);
  });

  it('does not pollute Object.prototype', () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    stripDangerousKeys(malicious);
    expect({}.polluted).toBeUndefined();
  });
});

describe('createJsonRepository: dangerous keys never persisted', () => {
  const tmpFile = '__probe53_tmp.json';
  const tmpPath = path.resolve(__dirname, '../../data', tmpFile);
  const repo = createJsonRepository(tmpFile);

  afterAll(() => {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  });

  it('create() strips dangerous keys before writing', () => {
    const malicious = JSON.parse('{"name":"x","__proto__":{"isAdmin":true},"constructor":{"z":1}}');
    const row = repo.create(malicious);
    expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'constructor')).toBe(false);
    expect(row.name).toBe('x');
    // and the persisted record on disk has no dangerous own key
    const onDisk = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    const stored = onDisk.find(r => r.id === row.id);
    expect(Object.prototype.hasOwnProperty.call(stored, '__proto__')).toBe(false);
    expect({}.isAdmin).toBeUndefined(); // prototype not polluted
  });

  it('update() / updateIf() strip dangerous keys before merging', () => {
    const row = repo.create({ name: 'y' });
    const malicious = JSON.parse('{"__proto__":{"isAdmin":true},"status":"ok"}');
    const updated = repo.update(row.id, malicious);
    expect(Object.prototype.hasOwnProperty.call(updated, '__proto__')).toBe(false);
    expect(updated.status).toBe('ok');

    const cas = repo.updateIf(row.id, () => true, JSON.parse('{"constructor":{"bad":1},"phase":2}'));
    expect(cas.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cas.row, 'constructor')).toBe(false);
    expect(cas.row.phase).toBe(2);
    expect({}.isAdmin).toBeUndefined();
  });
});
