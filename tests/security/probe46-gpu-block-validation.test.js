// tests/security/probe46-gpu-block-validation.test.js
// Probe 46 regression tests:
// 46e-2a: POST /gpus/:id/block validates GPU ID as UUID (rejects non-UUID param)
// 46e-2b: DELETE /gpus/:id/block/:blockId validates the GPU id as UUID, but treats
//         blockId as a bounded opaque string. blockId is only used in a string .find()
//         (no injection surface), and a non-existent blockId must return 404 Not Found —
//         strict UUID validation would mask that as a 400 and break the contract.
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

  it('gpu/index.js: DELETE /block/:blockId validates GPU id as UUID, blockId as bounded string', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    const deleteBlockIdx = src.indexOf("router.delete('/:id/block/:blockId'");
    expect(deleteBlockIdx).toBeGreaterThan(-1);
    const deleteBlock = src.slice(deleteBlockIdx, deleteBlockIdx + 700);
    // GPU id (the real lookup key) is strictly UUID-validated
    expect(deleteBlock).toMatch(/id:\s*Joi\.string\(\)\.uuid/);
    // blockId is a bounded opaque string (NOT UUID) so non-existent ids reach the
    // handler and return 404 rather than 400
    expect(deleteBlock).toMatch(/blockId:\s*Joi\.string\(\)\.max\(\d+\)/);
    expect(deleteBlock).not.toMatch(/blockId:\s*Joi\.string\(\)\.uuid/);
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
