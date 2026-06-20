// tests/security/probe34-ratelimit-graphql.test.js
// Probe 34 regression tests:
// 1. apiLimiter keyGenerator uses integer-only TRUST_PROXY (no XFF bypass via 'true')
// 2. TOTP rate limiter is backed by server-side IP counter (not just session-scoped)
// 3. GraphQL endpoint has rate limiting applied via apiLimiter
// 4. master-auth.js has _checkTotpIpLimit before session counter

describe('Rate limiting: keyGenerator XFF bypass fix', () => {
  it('security.js: _rlKeyGenerator uses parseInt(TRUST_PROXY) not truthy string check', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/security.js'), 'utf-8'
    );
    // Must use parseInt-based check (same as rate-limit.js)
    expect(src).toMatch(/parseInt\(process\.env\.TRUST_PROXY,\s*10\)/);
    expect(src).toMatch(/Number\.isInteger\(hopCount\) && hopCount > 0/);
    // Must NOT use the old vulnerable truthy-string check
    expect(src).not.toMatch(/trustProxy !== '0' && trustProxy !== 'false'/);
  });

  it('rate-limit.js and security.js use the same TRUST_PROXY parsing strategy', () => {
    const secSrc = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/security.js'), 'utf-8'
    );
    const rlSrc = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/rate-limit.js'), 'utf-8'
    );
    // Both must use parseInt and isInteger checks
    expect(secSrc).toMatch(/parseInt\(process\.env\.TRUST_PROXY,\s*10\)/);
    expect(rlSrc).toMatch(/parseInt\(process\.env\.TRUST_PROXY,\s*10\)/);
  });
});

describe('TOTP rate limiting: server-side IP counter supplements session counter', () => {
  it('master-auth.js has process-level IP-based TOTP rate limit map', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    // Must have the IP-level counter
    expect(src).toMatch(/_totpIpMap/);
    expect(src).toMatch(/_checkTotpIpLimit/);
    expect(src).toMatch(/TOTP_IP_WINDOW_MS/);
  });

  it('master-auth.js: IP limit check is called BEFORE session limit check', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    const ipIdx = src.indexOf('_checkTotpIpLimit(clientIp)');
    const sessIdx = src.indexOf('req.session.totpAttempts');
    expect(ipIdx).toBeGreaterThan(-1);
    expect(sessIdx).toBeGreaterThan(-1);
    expect(ipIdx).toBeLessThan(sessIdx);
  });

  it('_checkTotpIpLimit uses socket.remoteAddress (not req.ip) for XFF resistance', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
    );
    expect(src).toMatch(/req\.socket\.remoteAddress.*req\.ip/);
  });
});

describe('GraphQL: apiLimiter applied to /graphql endpoint', () => {
  it('graphql.js: apiLimiter is applied before Apollo middleware', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/graphql.js'), 'utf-8'
    );
    expect(src).toMatch(/apiLimiter/);
    expect(src).toMatch(/app\.use\(apiLimiter\)/);
    // Rate limiter must be applied before server.applyMiddleware
    const limiterIdx = src.indexOf('app.use(apiLimiter)');
    const apolloIdx = src.indexOf('server.applyMiddleware');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(apolloIdx).toBeGreaterThan(-1);
    expect(limiterIdx).toBeLessThan(apolloIdx);
  });
});
