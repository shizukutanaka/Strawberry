// tests/security/probe46-gpu-block-validation.test.js
// Probe 46 regression tests:
// 46e-2a: POST /gpus/:id/block validates GPU ID as UUID (rejects non-UUID param)
// 46e-2b: DELETE /gpus/:id/block/:blockId validates both ID and blockId as UUIDs
// 46a-1/46a-2: live reference false positive — confirmed no in-memory cache;
//              load() reads fresh from disk and withLock serializes concurrent ops

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 46e-2: UUID validation on block endpoints ────────────────────────────
describe('POST /gpus/:id/block: requires valid UUID for GPU id', () => {
  it('gpu/index.js: POST /block route has validateMiddleware with uuid params schema', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // The block creation route must have validateMiddleware with 'params' source
    const postBlockIdx = src.indexOf("'/:id/block',\n  authenticateJWT,\n  validateMiddleware");
    expect(postBlockIdx).toBeGreaterThan(-1);
  });

  it('gpu/index.js: DELETE /block/:blockId route has validateMiddleware for both id and blockId', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    const deleteBlockIdx = src.indexOf("'/:id/block/:blockId',\n  authenticateJWT,\n  validateMiddleware");
    expect(deleteBlockIdx).toBeGreaterThan(-1);
    // blockId must also be validated as UUID
    const deleteBlock = src.slice(deleteBlockIdx, deleteBlockIdx + 300);
    expect(deleteBlock).toMatch(/blockId.*uuid|uuid.*blockId/s);
  });
});

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

  it('createJsonRepository.js: withLock is used on both block add and block delete', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // Both endpoints use the same per-GPU lock key
    const lockMatches = (src.match(/withLock\(`gpu:\$\{gpuId\}:blocks`/g) || []).length;
    expect(lockMatches).toBeGreaterThanOrEqual(2);
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
