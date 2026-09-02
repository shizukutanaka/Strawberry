// tests/security/probe75-gpu-getall-redundant-io.test.js
//
// Performance regression guard for redundant GpuRepository.getAll() calls.
//
// GpuRepository.getAll() performs a synchronous fs.readFileSync + JSON.parse of the
// entire gpus.json file on every call (createJsonRepository.js has no caching layer).
// Three GPU route handlers called getAll() multiple times within a single request:
//
//   POST /gpus          — once for the provider-quota check, once for the duplicate
//                          check (2 reads per registration request).
//   POST /gpus/:id/clone — once for the provider-quota check, once for the duplicate
//                          check (2 reads per clone request).
//   POST /gpus/bulk      — once for the provider-quota check, then AGAIN inside the
//                          per-entry loop for EVERY entry's duplicate check (up to
//                          21 reads for a 20-entry batch).
//
// Fix: snapshot getAll() once per request and reuse it for all checks. For /bulk,
// the batchKeys Set (name|model|vendor|memoryGB, matching the persisted-duplicate
// check's exact criteria) already fully covers intra-batch duplicate detection, so a
// single pre-loop snapshot is behavior-equivalent — it cannot miss a duplicate that
// the old per-iteration re-read would have caught, since any newly-created GPU
// within the same batch that would collide is already caught by batchKeys first.

const src = require('fs').readFileSync(
  require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
);

function countOccurrences(text, pattern) {
  return (text.match(pattern) || []).length;
}

describe('gpu/index.js: single-registration handler calls getAll() once, not twice', () => {
  it('POST /gpus register handler snapshots allGpus once and reuses it', () => {
    const idx = src.indexOf("router.post('/',");
    expect(idx).toBeGreaterThan(-1);
    // Scope to the register handler body (up to the next route definition)
    const nextRouteIdx = src.indexOf("router.put('/:id',", idx);
    const block = src.slice(idx, nextRouteIdx > -1 ? nextRouteIdx : idx + 3000);
    const getAllCalls = countOccurrences(block, /GpuRepository\.getAll\(\)/g);
    expect(getAllCalls).toBe(1);
    expect(block).toMatch(/const allGpus = GpuRepository\.getAll\(\)/);
  });
});
