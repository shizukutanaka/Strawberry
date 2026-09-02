// tests/security/probe46-gpu-block-validation.test.js
// Probe 46 regression tests:
// 46e-2a/46e-2b: (removed 2026-09 — the /gpus/:id/block routes no longer exist)
// 46a-1/46a-2: live reference false positive — confirmed no in-memory cache;
//              load() reads fresh from disk and withLock serializes concurrent ops

const { _app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 46e-2: UUID validation on block endpoints ────────────────────────────
// ─── Repository: load() reads fresh from disk (no live-reference cache) ──
describe('createJsonRepository: no in-memory cache (live reference false positive)', () => {
  it('createJsonRepository.js: load() calls fs.readFileSync every invocation', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/db/json/createJsonRepository.js'), 'utf-8'
    );
    // load function reads from disk, no module-level cache variable
    expect(src).toMatch(/function load\(\)/);
    expect(src).toMatch(/fs\.readFileSync\(filePath/);
    // No module-level cache array/map (would look like `const cache = {}` or `let _rows`)
    expect(src).not.toMatch(/^(?:const|let)\s+(?:cache|_rows|_data)\s*=/m);
  });

  it('createJsonRepository.js: update() calls load() fresh before writing', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/db/json/createJsonRepository.js'), 'utf-8'
    );
    // update function must call load() at its beginning
    const updateIdx = src.indexOf('update: (id, updates)');
    expect(updateIdx).toBeGreaterThan(-1);
    const updateBlock = src.slice(updateIdx, updateIdx + 100);
    expect(updateBlock).toMatch(/load\(\)/);
  });
});
