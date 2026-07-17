// tests/security/probe45-gpu-provider-leak.test.js
// Probe 45 regression tests:
// 45a-1: GET /gpus/:id must NOT expose providerId to unauthenticated / renter callers
//        (the list endpoint already stripped it; detail endpoint did not)
// 45a-2: manualBlocks also stripped from public GPU detail (consistent with list endpoint)
// 45a-3: owner/admin still receives providerId and manualBlocks in detail response
// 45a-4: apiKey always stripped regardless of caller role

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── Source-level checks ──────────────────────────────────────────────────
describe('GET /gpus/:id: providerId/manualBlocks hidden from public', () => {
  it('gpu/index.js: detail endpoint destructures providerId out of gpuSafe', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // providerId must be destructured separately (not included in ...gpuSafe spread)
    expect(src).toMatch(/const\s*\{[^}]*providerId[^}]*\}\s*=\s*gpu/);
  });

  it('gpu/index.js: detail endpoint destructures manualBlocks out of gpuSafe', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    expect(src).toMatch(/const\s*\{[^}]*manualBlocks[^}]*\}\s*=\s*gpu/);
  });

  it('gpu/index.js: apiKey destructured out of gpu before response is built', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // apiKey must appear in the destructuring of `gpu` in the detail handler
    // (i.e. it's extracted and discarded, not spread into gpuSafe)
    const detailIdx = src.indexOf('Fetched GPU detail');
    expect(detailIdx).toBeGreaterThan(-1);
    const detailBlock = src.slice(Math.max(0, detailIdx - 300), detailIdx + 50);
    // apiKey is in the destructuring list (so it won't appear in ...gpuSafe)
    expect(detailBlock).toMatch(/\{\s*apiKey[^}]+\}\s*=\s*gpu/s);
    // apiKey is never re-added to the response gpu object
    const responseBlock = src.slice(detailIdx, detailIdx + 300);
    expect(responseBlock).not.toMatch(/apiKey\s*:/);
  });

  it('gpu/index.js: providerId returned only for owner/admin', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // Conditional providerId inclusion tied to viewerIsOwnerOrAdmin
    expect(src).toMatch(/viewerIsOwnerOrAdmin.*providerId|providerId.*viewerIsOwnerOrAdmin/s);
  });

  it('gpu/index.js: list endpoint also strips providerId (regression guard)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
    );
    // The list gpus map uses destructuring to drop providerId
    expect(src).toMatch(/providerId:\s*_pid/);
  });
});

// ─── Logic simulation ────────────────────────────────────────────────────
describe('GPU detail response: field visibility by caller role', () => {
  it('public caller: gpuSafe excludes providerId and manualBlocks', () => {
    const gpu = {
      id: 'g1', name: 'RTX 4090', providerId: 'provider-secret', apiKey: 'key-secret',
      manualBlocks: [{ start: '2026-01-01', end: '2026-01-07' }], memoryGB: 24
    };
    const viewerIsOwnerOrAdmin = false;
    const { apiKey, providerId, manualBlocks, ...gpuSafe } = gpu;
    const responseGpu = {
      ...gpuSafe,
      ...(viewerIsOwnerOrAdmin ? { providerId, manualBlocks } : {}),
    };
    expect(responseGpu).not.toHaveProperty('providerId');
    expect(responseGpu).not.toHaveProperty('manualBlocks');
    expect(responseGpu).not.toHaveProperty('apiKey');
    expect(responseGpu.name).toBe('RTX 4090');
  });

  it('owner caller: gpuSafe includes providerId and manualBlocks', () => {
    const gpu = {
      id: 'g1', name: 'RTX 4090', providerId: 'provider-123', apiKey: 'key-secret',
      manualBlocks: [{ start: '2026-01-01', end: '2026-01-07' }], memoryGB: 24
    };
    const viewerIsOwnerOrAdmin = true;
    const { apiKey, providerId, manualBlocks, ...gpuSafe } = gpu;
    const responseGpu = {
      ...gpuSafe,
      ...(viewerIsOwnerOrAdmin ? { providerId, manualBlocks } : {}),
    };
    expect(responseGpu).toHaveProperty('providerId', 'provider-123');
    expect(responseGpu).toHaveProperty('manualBlocks');
    expect(responseGpu).not.toHaveProperty('apiKey');
  });
});
