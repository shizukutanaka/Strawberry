// tests/security/probe45-gpu-provider-leak.test.js
// Probe 45 regression tests:
// 45a-1: GET /gpus/:id must NOT expose providerId to unauthenticated / renter callers
//        (the list endpoint already stripped it; detail endpoint did not)
// 45a-2/45a-3: (2026-09 — manualBlocks は手動ブロック機能ごと削除されたため対象外。
//              providerId の owner/admin 限定返却は 45a-1 と下の source check が見る)
// 45a-4: apiKey always stripped regardless of caller role

const { _app } = require('../../src/api/server');

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
