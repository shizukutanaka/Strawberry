// tests/security/probe42-review-notify.test.js
// Probe 42 regression tests:
// 42a-1: dispute counts (deniedDisputeCount/vindicatedDisputeCount) hidden from sanitizeUser output
// 42a-2: dispute counts removed from SENSITIVE_USER_FIELDS list
// 42a-3: ratingAverage clamped to [1, 5] in renter-profile
// 42a-4: ratingAverage uses clamped values per review
// 42b-1: notifier AXIOS_SAFE_CONFIG defined with timeout + size limits
// 42b-2: all axios.post calls in notifier use AXIOS_SAFE_CONFIG (no unbounded calls)
// 42c-1: review handler enforces 30-day window after order completion
// 42c-2: renter-review handler enforces 30-day window after order completion

const request = require('supertest');
const { app } = require('../../src/api/server');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ─── 42a-1/42a-2: sanitizeUser hides dispute count fields ─────────────────
describe('sanitizeUser: dispute counts hidden from API responses', () => {
  it('sanitize-user.js: deniedDisputeCount in SENSITIVE_USER_FIELDS', () => {
    const { SENSITIVE_USER_FIELDS } = require('../../src/api/utils/sanitize-user');
    expect(SENSITIVE_USER_FIELDS).toContain('deniedDisputeCount');
  });

  it('sanitize-user.js: vindicatedDisputeCount in SENSITIVE_USER_FIELDS', () => {
    const { SENSITIVE_USER_FIELDS } = require('../../src/api/utils/sanitize-user');
    expect(SENSITIVE_USER_FIELDS).toContain('vindicatedDisputeCount');
  });

  it('sanitizeUser: strips deniedDisputeCount from user object', () => {
    const { sanitizeUser } = require('../../src/api/utils/sanitize-user');
    const user = { id: 'u1', username: 'alice', deniedDisputeCount: 3, password: 'hash' };
    const safe = sanitizeUser(user);
    expect(safe).not.toHaveProperty('deniedDisputeCount');
    expect(safe).not.toHaveProperty('password');
    expect(safe.username).toBe('alice');
  });

  it('sanitizeUser: strips vindicatedDisputeCount from user object', () => {
    const { sanitizeUser } = require('../../src/api/utils/sanitize-user');
    const user = { id: 'u1', username: 'bob', vindicatedDisputeCount: 7, apiKey: 'secret' };
    const safe = sanitizeUser(user);
    expect(safe).not.toHaveProperty('vindicatedDisputeCount');
    expect(safe).not.toHaveProperty('apiKey');
    expect(safe.username).toBe('bob');
  });
});

// ─── 42a-3/42a-4: ratingAverage clamped in renter-profile ────────────────
describe('renter-profile: ratingAverage clamped to [1, 5]', () => {
  it('user/index.js: each renter-profile review rating is clamped to [1,5] before averaging', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // Probe74 fix: per-review clamping happens via validRatings.map(Math.min(5, Math.max(1, r))),
    // applied only to Number.isFinite-validated ratings (invalid ratings excluded, not
    // defaulted to 1). Averaging already-clamped [1,5] values can never leave [1,5], so an
    // additional outer clamp on the final average is redundant and was removed.
    const idx = src.indexOf("renterOrders = OrderRepository.getAll().filter(o => o.userId === userId && o.renterReview)");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/Math\.min\(5,\s*Math\.max\(1,\s*r\)\)/);
    expect(block).toMatch(/Number\.isFinite\(r\)/);
  });

  it('user/index.js: raw renterReview.rating not used directly in sum without clamping', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/user/index.js'), 'utf-8'
    );
    // The old unclamped form should be gone
    expect(src).not.toMatch(/reduce.*s \+ o\.renterReview\.rating/);
  });
});

// ─── 42b-1/42b-2: notifier AXIOS_SAFE_CONFIG usage ───────────────────────
describe('notifier: AXIOS_SAFE_CONFIG applied to all axios calls', () => {
  it('notifier.js: AXIOS_SAFE_CONFIG defined with timeout and size limits', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/AXIOS_SAFE_CONFIG/);
    expect(src).toMatch(/timeout.*10.?000|10_000.*timeout/s);
    expect(src).toMatch(/maxContentLength/);
    expect(src).toMatch(/maxBodyLength/);
  });

  it('notifier.js: sendDiscordNotify uses AXIOS_SAFE_CONFIG', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    // Must pass AXIOS_SAFE_CONFIG to the Discord webhook post
    expect(src).toMatch(/axios\.post\(webhookUrl,\s*\{[^}]*content[^}]*\},\s*AXIOS_SAFE_CONFIG\)/s);
  });

  it('notifier.js: sendSlackNotify uses AXIOS_SAFE_CONFIG', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/axios\.post\(webhookUrl,\s*\{[^}]*text[^}]*\},\s*AXIOS_SAFE_CONFIG\)/s);
  });

  it('notifier.js: sendTelegramNotify uses AXIOS_SAFE_CONFIG', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/axios\.post\(url,\s*\{[^}]*chat_id[^}]*\},\s*AXIOS_SAFE_CONFIG\)/s);
  });

  it('notifier.js: sendLineNotify uses AXIOS_SAFE_CONFIG', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/AXIOS_SAFE_CONFIG.*Authorization|Authorization.*AXIOS_SAFE_CONFIG/s);
  });

  it('notifier.js: sendWebhookNotify uses AXIOS_SAFE_CONFIG', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/axios\.post\(webhookUrl,\s*\{[^}]*message[^}]*payload[^}]*\},\s*AXIOS_SAFE_CONFIG\)|axios\.post\(webhookUrl,\s*\{\s*message,\s*\.\.\.payload\s*\},\s*AXIOS_SAFE_CONFIG\)/s);
  });
});

// ─── 42c-1/42c-2: review time window enforcement ─────────────────────────
describe('review handlers: 30-day window enforced', () => {
  it('order/index.js: /review checks completedAt + 30-day window', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    expect(src).toMatch(/completedAt/);
    expect(src).toMatch(/daysSinceCompletion.*>.*30|30.*daysSinceCompletion/s);
    expect(src).toMatch(/within 30 days/);
  });

  it('order/index.js: /renter-review also checks 30-day window', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/order/index.js'), 'utf-8'
    );
    // Count occurrences: both review handlers must have the 30-day check
    const count = (src.match(/within 30 days/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
