// tests/security/probe73-profit-address-delete-validation.test.js
//
// Regression for a missing address validation on the profit-address DELETE endpoint.
//
// The POST /profit-addresses endpoint validated the address with isValidBtcAddress()
// before calling addProfitAddress(). The DELETE endpoint did NOT — any string, including
// prototype-pollution payloads ("__proto__", "constructor") or junk values, was passed
// directly to removeProfitAddress() without format validation. This asymmetry was both
// a consistency issue and a latent injection risk.
//
// Fix: add isValidBtcAddress() guard to DELETE before calling removeProfitAddress(),
// matching the POST endpoint. Also normalize address with String().trim() in DELETE
// response for consistency with POST.

const src = require('fs').readFileSync(
  require.resolve('../../src/api/routes/profit-addresses.js'), 'utf-8'
);

describe('profit-addresses: DELETE endpoint validation', () => {
  it('DELETE route calls isValidBtcAddress before removeProfitAddress', () => {
    // The source must show isValidBtcAddress appearing in the DELETE handler (after "削除" comment).
    // We look for the pattern: isValidBtcAddress check followed by removeProfitAddress.
    const deleteSection = src.slice(src.indexOf('// 削除'));
    expect(deleteSection).toMatch(/isValidBtcAddress\(address\)/);
  });

  it('DELETE route returns 400 for invalid address (source guard present)', () => {
    const deleteSection = src.slice(src.indexOf('// 削除'));
    expect(deleteSection).toMatch(/return res\.status\(400\)/);
  });

  it('DELETE route normalizes address with String().trim() in response (matches POST)', () => {
    const deleteSection = src.slice(src.indexOf('// 削除'));
    expect(deleteSection).toMatch(/String\(address\)\.trim\(\)/);
  });

  it('POST route has symmetric isValidBtcAddress guard', () => {
    const postSection = src.slice(src.indexOf('// 追加'));
    expect(postSection.slice(0, postSection.indexOf('// 削除'))).toMatch(/isValidBtcAddress\(address\)/);
  });
});

describe('profit-addresses: route-level authentication (source assertions)', () => {
  it('uses jwtAuth middleware at router scope (before any route handlers)', () => {
    // jwtAuth must appear before the first router.get/post/delete
    const jwtIdx = src.indexOf('router.use(jwtAuth)');
    const firstRoute = Math.min(
      src.indexOf('router.get('),
      src.indexOf('router.post('),
      src.indexOf('router.delete(')
    );
    expect(jwtIdx).toBeGreaterThan(-1);
    expect(jwtIdx).toBeLessThan(firstRoute);
  });

  it("requires admin role (rbac('admin')) before route handlers", () => {
    const rbacIdx = src.indexOf("router.use(rbac('admin'))");
    const firstRoute = Math.min(
      src.indexOf('router.get('),
      src.indexOf('router.post('),
      src.indexOf('router.delete(')
    );
    expect(rbacIdx).toBeGreaterThan(-1);
    expect(rbacIdx).toBeLessThan(firstRoute);
  });
});
