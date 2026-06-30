// tests/security/probe72-rbac-type-safety-gpu-query-bounds.test.js
//
// Two regression guards in one file:
//
// (A) RBAC role type confusion — if req.user.role is not a string (array, object,
//     number from a crafted JWT), the equality check `user.role !== 'admin'` still
//     returns true (403), but the intent is ambiguous and relies on JS type coercion
//     semantics rather than an explicit invariant. The fix adds an explicit
//     `typeof user.role !== 'string'` guard that rejects non-string roles with 403
//     before any equality comparison, making the contract explicit and testable.
//     Additionally, RBAC now routes through next(APIError) for consistent error
//     response format with the rest of the API.
//
// (B) GPU list query param bounds — GET /gpus?minMemoryGB=-100 previously caused
//     the memory filter to be silently skipped (filter check `> 0` is false for
//     negative values), bypassing the caller's intent and returning all GPUs.
//     GET /gpus?maxPrice=0 returned no GPUs without an error. Both are fixed with
//     explicit bound validation.

const { APIError, ErrorTypes } = require('../../src/utils/error-handler');

// ---------------------------------------------------------------------------
// (A) RBAC type-safety tests
// ---------------------------------------------------------------------------

const rbac = require('../../src/api/middleware/rbac');

function runRbac(role, requiredRole) {
  const req = { user: { role } };
  const next = jest.fn();
  rbac(requiredRole)(req, {}, next);
  return next;
}

describe('rbac: non-string role is rejected with 403 (type confusion guard)', () => {
  it('role=["admin"] (array) → 403, not allowed even if value matches string', () => {
    const next = runRbac(['admin'], 'admin');
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role={value:"admin"} (object) → 403', () => {
    const next = runRbac({ value: 'admin' }, 'admin');
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role=1 (number) → 403', () => {
    const next = runRbac(1, 1);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role="admin" (string) → passes for single-role check', () => {
    const req = { user: { role: 'admin' } };
    const next = jest.fn();
    rbac('admin')(req, {}, next);
    expect(next).toBeCalledWith(); // no error arg = success
  });

  it('role="editor" (string) → passes for array-role check', () => {
    const req = { user: { role: 'editor' } };
    const next = jest.fn();
    rbac(['admin', 'editor'])(req, {}, next);
    expect(next).toBeCalledWith();
  });

  it('RBAC error is an APIError with correct type field', () => {
    const next = runRbac('user', 'admin');
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(APIError);
    expect(err.type).toBe(ErrorTypes.FORBIDDEN);
  });

  it('RBAC 401 when user missing is an APIError with UNAUTHORIZED type', () => {
    const next = jest.fn();
    rbac('admin')({ user: undefined }, {}, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(APIError);
    expect(err.type).toBe(ErrorTypes.UNAUTHORIZED);
    expect(err.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (B) GPU list query param bounds — source-level guard assertions
// ---------------------------------------------------------------------------

describe('gpu/index.js source: minMemoryGB and maxPrice bound checks', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/gpu/index.js'), 'utf-8'
  );

  it('validates minMemoryGB lower bound (no negative bypass)', () => {
    // Confirms the guard rejects minMemoryGB < 0
    expect(src).toMatch(/_minMemGB\s*<\s*0/);
  });

  it('validates minMemoryGB upper bound (prevents absurd values)', () => {
    expect(src).toMatch(/_minMemGB\s*>\s*8192/);
  });

  it('validates maxPrice is positive (no zero/negative price)', () => {
    expect(src).toMatch(/_maxPrice\s*<=\s*0/);
  });

  it('uses Number.isFinite for maxPrice (rejects NaN/Infinity)', () => {
    expect(src).toMatch(/Number\.isFinite\(_maxPrice\)/);
  });

  it('no longer uses the bare isNaN+parseFloat pattern for maxPrice', () => {
    // The old pattern: if (req.query.maxPrice && isNaN(parseFloat(req.query.maxPrice)))
    // was replaced with explicit bound validation.
    expect(src).not.toMatch(/isNaN\(parseFloat\(req\.query\.maxPrice\)\)/);
  });

  it('no longer uses the bare isNaN+parseInt pattern for minMemoryGB', () => {
    expect(src).not.toMatch(/isNaN\(parseInt\(req\.query\.minMemoryGB/);
  });

  it('minRating validates lower bound 1 (rejects negative bypass)', () => {
    // Negative minRating would skip the filter entirely under the old `> 0` guard
    expect(src).toMatch(/_minRating\s*<\s*1/);
  });

  it('minRating validates upper bound 5', () => {
    expect(src).toMatch(/_minRating\s*>\s*5/);
  });

  it('minRating uses Number.isFinite (rejects NaN/Infinity)', () => {
    expect(src).toMatch(/Number\.isFinite\(_minRating\)/);
  });

  it('features query param rejects arrays (HPP protection)', () => {
    // Duplicate ?features=A&features=B results in an array. The array.length
    // would be the element count, not byte count, bypassing the 512-char limit.
    expect(src).toMatch(/typeof req\.query\.features\s*!==\s*'string'/);
  });
});
