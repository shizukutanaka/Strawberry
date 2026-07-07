// tests/security/probe70-master-auth-timing-safe-compare.test.js
// Regression / hardening for the master-auth timing-safe string comparison.
//
// timingSafeStrEqual() compares the emailed master-auth code against the session
// value. The previous implementation short-circuited on a length mismatch
// (`if (ab.length !== bb.length) return false`) BEFORE running timingSafeEqual.
// That early return is itself a timing oracle: an attacker measuring response
// time could learn the secret's length (fast path = wrong length, slow path =
// right length). The current caller uses a fixed 6-digit code so the practical
// impact was nil, but timingSafeStrEqual is a general-purpose helper.
//
// Fix: adopt the same Double-HMAC pattern already used by security.js's API-key
// check — HMAC both inputs to fixed-length (32B) digests with a random nonce,
// then timingSafeEqual. Length never leaks and timingSafeEqual never throws.

const crypto = require('crypto');
const { _timingSafeStrEqual: eq } = require('../../src/api/routes/master-auth');

describe('master-auth timingSafeStrEqual: correctness', () => {
  it('returns true for identical strings', () => {
    expect(eq('123456', '123456')).toBe(true);
  });

  it('returns false for same-length but different strings', () => {
    expect(eq('123456', '654321')).toBe(false);
  });

  it('returns false for different-length strings WITHOUT throwing', () => {
    // The whole point: no early length-check, and timingSafeEqual must not throw
    // on unequal raw lengths because both sides are HMAC-normalized first.
    expect(() => eq('12345', '1234567')).not.toThrow();
    expect(eq('12345', '1234567')).toBe(false);
  });

  it('treats null/undefined as empty string', () => {
    expect(eq(null, '')).toBe(true);
    expect(eq(undefined, '')).toBe(true);
    expect(eq(null, 'x')).toBe(false);
  });

  it('coerces non-string inputs via String() (matches prior contract)', () => {
    expect(eq(123456, '123456')).toBe(true);
  });

  it('returns false when comparing a real 6-digit code to a wrong guess', () => {
    const real = crypto.randomInt(100000, 1000000).toString();
    let wrong = crypto.randomInt(100000, 1000000).toString();
    while (wrong === real) wrong = crypto.randomInt(100000, 1000000).toString();
    expect(eq(real, real)).toBe(true);
    expect(eq(wrong, real)).toBe(false);
  });
});

describe('master-auth timingSafeStrEqual: no length-leak short-circuit in source', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
  );

  it('uses HMAC normalization before timingSafeEqual (Double-HMAC pattern)', () => {
    expect(src).toMatch(/createHmac\(['"]sha256['"],\s*nonce\)/);
    expect(src).toMatch(/crypto\.timingSafeEqual\(aHash,\s*bHash\)/);
  });

  it('no longer early-returns false on a raw length mismatch', () => {
    // The vulnerable form compared raw buffer lengths before timingSafeEqual.
    expect(src).not.toMatch(/if\s*\(ab\.length\s*!==\s*bb\.length\)\s*return false/);
  });

  it('derives a fresh random nonce per comparison', () => {
    expect(src).toMatch(/crypto\.randomBytes\(32\)/);
  });
});
