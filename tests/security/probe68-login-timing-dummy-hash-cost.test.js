// tests/security/probe68-login-timing-dummy-hash-cost.test.js
// Regression for a latent account-enumeration timing leak.
//
// The login handler compares the submitted password against a real bcrypt hash
// (existing user) or a _DUMMY_HASH (non-existent user) so both paths run bcrypt
// and take the same time — preventing email enumeration via response timing.
//
// The bug: _DUMMY_HASH was hardcoded to cost factor 10, while real password hashes
// use config.security.bcryptRounds. These are equal by default (10), so no leak
// out of the box — BUT the moment an operator follows the standard hardening advice
// and sets BCRYPT_ROUNDS=12, real hashes become cost-12 (~250ms) while the dummy
// stays cost-10 (~60ms), reopening a ~180ms timing oracle.
//
// Fix: derive _DUMMY_HASH from config.security.bcryptRounds so the two costs can
// never drift. These tests assert the source derives the cost from config and that
// the resulting hash's embedded cost matches the configured rounds.

const bcrypt = require('bcrypt');
const { config } = require('../../src/utils/config');

// bcrypt hash format: $2b$<cost>$<salt+digest> — extract the cost field.
function costOf(hash) {
  const m = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  return m ? Number(m[1]) : null;
}

describe('login dummy-hash cost matches the production bcrypt cost factor', () => {
  it('source derives _DUMMY_HASH cost from config.security.bcryptRounds (not a literal)', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // Must build the dummy hash using the configured rounds…
    expect(src).toMatch(/_DUMMY_HASH\s*=\s*bcrypt\.hashSync\([^,]+,\s*config\.security\.bcryptRounds\s*\)/);
    // …and must NOT hardcode a numeric cost for the dummy hash.
    expect(src).not.toMatch(/_DUMMY_HASH\s*=\s*bcrypt\.hashSync\([^,]+,\s*\d+\s*\)/);
  });

  it('a dummy hash built from config has the same embedded cost as a real password hash', () => {
    const rounds = config.security.bcryptRounds;
    const dummy = bcrypt.hashSync('strawberry-timing-guard', rounds);
    const real = bcrypt.hashSync('a-user-password', rounds);
    expect(costOf(dummy)).toBe(rounds);
    expect(costOf(real)).toBe(rounds);
    expect(costOf(dummy)).toBe(costOf(real)); // identical cost → comparable timing
  });

  it('demonstrates the regression: a literal cost-10 dummy diverges from a cost-12 real hash', () => {
    // This is the bug the fix prevents — left as an explicit guard so a future
    // refactor that re-hardcodes the dummy cost is caught by the assertion above.
    const literalDummyCost = costOf(bcrypt.hashSync('x', 10));
    const hardenedRealCost = costOf(bcrypt.hashSync('x', 12));
    expect(literalDummyCost).toBe(10);
    expect(hardenedRealCost).toBe(12);
    expect(literalDummyCost).not.toBe(hardenedRealCost); // the divergence we must avoid
  });
});
