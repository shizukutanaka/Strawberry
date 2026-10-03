// createJsonRepository の updateIf（CAS プリミティブ）の契約を直接固定するテスト。
// updateIf は btc-onchain 冪等・エスクロー・係争カウンタ・gpu-auto-recovery 等の
// 全 CAS 経路の基礎だが、戻り値形状・merge 意味論・危険キー除去の直接テストが無かった。
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
const { resolveDataDir } = require('../../src/db/json/data-dir');

describe('createJsonRepository.updateIf', () => {
  const fileName = `updateif-probe-${process.pid}-${Date.now()}.json`;
  const filePath = path.join(resolveDataDir(), fileName);
  const repo = createJsonRepository(fileName, {});

  afterAll(() => {
    try { fs.rmSync(filePath, { force: true }); } catch (_) { /* noop */ }
  });

  it('returns {ok:false, reason:"not_found"} for a missing id', () => {
    const res = repo.updateIf('nonexistent', () => true, { a: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('returns {ok:false, reason:"condition_failed", current} and writes nothing when predicate fails', () => {
    const row = repo.create({ status: 'active', keep: 'x' });
    const res = repo.updateIf(row.id, (r) => r.status === 'completed', { status: 'cancelled' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('condition_failed');
    expect(res.current.status).toBe('active');
    // 述語失敗時は一切書き込まない（行は不変）
    expect(repo.getById(row.id).status).toBe('active');
    repo.delete(row.id);
  });

  it('merges updates and persists when predicate passes', () => {
    const row = repo.create({ status: 'active', keep: 'x', n: 1 });
    const res = repo.updateIf(row.id, (r) => r.status === 'active', { status: 'cancelled', n: 2 });
    expect(res.ok).toBe(true);
    expect(res.row.status).toBe('cancelled');
    expect(res.row.n).toBe(2);
    expect(res.row.keep).toBe('x'); // 部分 merge — 指定外フィールドは保持
    const reloaded = repo.getById(row.id);
    expect(reloaded.status).toBe('cancelled');
    repo.delete(row.id);
  });

  it('strips dangerous keys from updates', () => {
    const row = repo.create({ status: 'active' });
    const updates = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "ok": 1}');
    const res = repo.updateIf(row.id, () => true, updates);
    expect(res.ok).toBe(true);
    const saved = repo.getById(row.id);
    expect(Object.prototype.hasOwnProperty.call(saved, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved, 'constructor')).toBe(false);
    expect(saved.ok).toBe(1);
    expect({}.polluted).toBeUndefined(); // プロトタイプ汚染なし
    repo.delete(row.id);
  });

  it('emits updateIf audit via onAccess without breaking on hook errors', () => {
    const events = [];
    const auditRepo = createJsonRepository(`updateif-audit-${process.pid}.json`, {
      onAccess: (action, detail) => { events.push({ action, detail }); },
    });
    const row = auditRepo.create({ v: 1 });
    auditRepo.updateIf(row.id, () => true, { v: 2 });
    expect(events.some((e) => e.action === 'updateIf')).toBe(true);

    const throwingRepo = createJsonRepository(`updateif-audit2-${process.pid}.json`, {
      onAccess: () => { throw new Error('audit boom'); },
    });
    const r2 = throwingRepo.create({ v: 1 });
    // 監査フックの失敗は本処理を妨げない
    expect(throwingRepo.updateIf(r2.id, () => true, { v: 9 }).ok).toBe(true);
    try {
      fs.rmSync(path.join(resolveDataDir(), `updateif-audit-${process.pid}.json`), { force: true });
      fs.rmSync(path.join(resolveDataDir(), `updateif-audit2-${process.pid}.json`), { force: true });
    } catch (_) { /* noop */ }
  });
});

describe('createJsonRepository fileName guard', () => {
  it('rejects path separators / non-.json names', () => {
    expect(() => createJsonRepository('../escape.json')).toThrow(/invalid fileName/);
    expect(() => createJsonRepository('a/b.json')).toThrow(/invalid fileName/);
    expect(() => createJsonRepository('noext')).toThrow(/invalid fileName/);
    expect(() => createJsonRepository('ok.json')).not.toThrow();
    try { fs.rmSync(path.join(resolveDataDir(), 'ok.json'), { force: true }); } catch (_) { /* noop */ }
  });
});
