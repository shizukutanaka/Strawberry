// tests/security/probe67-ratelimit-ipv6-subnet.test.js
// Regression for an IPv6 rate-limit bypass.
//
// express-rate-limit's built-in key generator normalizes IPv6 addresses to a /64
// subnet, because an IPv6 customer is allocated a whole /64 (2^64 addresses). A
// custom keyGenerator that returns the raw IP loses this normalization, so an
// attacker with a single /64 can rotate through addresses — each getting its own
// bucket — and fully bypass authLimiter's brute-force protection.
//
// Fix: normalizeIpKey() folds any IPv6 address to its /64 prefix before it becomes
// the rate-limit key. IPv4 and IPv4-mapped IPv6 pass through unchanged.

const rl = require('../../src/api/middleware/rate-limit');
const normalizeIpKey = rl._normalizeIpKey;
const keyGen = rl._rateLimitKeyGenerator;

describe('normalizeIpKey: IPv6 /64 subnet folding', () => {
  it('folds two addresses in the same /64 to the same key', () => {
    const a = normalizeIpKey('2001:db8:abcd:1234:0000:0000:0000:0001');
    const b = normalizeIpKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:abcd:1234::/64');
  });

  it('keeps addresses in DIFFERENT /64 subnets separate', () => {
    const a = normalizeIpKey('2001:db8:abcd:1234::1');
    const b = normalizeIpKey('2001:db8:abcd:5678::1'); // 4th hextet differs
    expect(a).not.toBe(b);
  });

  it('handles :: compression correctly', () => {
    // 2001:db8::1 expands to 2001:db8:0:0:0:0:0:1 → /64 prefix is 2001:db8:0:0
    expect(normalizeIpKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('handles a fully-compressed loopback (::1)', () => {
    // ::1 → 0:0:0:0:0:0:0:1 → /64 prefix 0:0:0:0
    expect(normalizeIpKey('::1')).toBe('0:0:0:0::/64');
  });

  it('returns IPv4 addresses unchanged', () => {
    expect(normalizeIpKey('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIpKey('10.0.0.1')).toBe('10.0.0.1');
  });

  it('maps IPv4-mapped IPv6 to the inner IPv4', () => {
    expect(normalizeIpKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('strips a link-local zone id before folding', () => {
    expect(normalizeIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('returns "unknown" for empty/invalid input', () => {
    expect(normalizeIpKey('')).toBe('unknown');
    expect(normalizeIpKey(null)).toBe('unknown');
    expect(normalizeIpKey(undefined)).toBe('unknown');
  });

  it('passes through non-IP strings (defensive)', () => {
    expect(normalizeIpKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('rateLimitKeyGenerator: integration with normalization', () => {
  const origTrustProxy = process.env.TRUST_PROXY;
  afterEach(() => {
    if (origTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = origTrustProxy;
  });

  it('uses socket.remoteAddress (not spoofable req.ip) when TRUST_PROXY is unset', () => {
    delete process.env.TRUST_PROXY;
    const req = {
      ip: '1.2.3.4',                       // attacker-controlled X-Forwarded-For
      socket: { remoteAddress: '203.0.113.9' }, // real TCP peer
    };
    expect(keyGen(req)).toBe('203.0.113.9');
  });

  it('trusts req.ip only when TRUST_PROXY is a positive integer', () => {
    process.env.TRUST_PROXY = '1';
    const req = {
      ip: '203.0.113.50',
      socket: { remoteAddress: '10.0.0.1' },
    };
    expect(keyGen(req)).toBe('203.0.113.50');
  });

  it('rejects boolean-string TRUST_PROXY (falls back to socket address)', () => {
    process.env.TRUST_PROXY = 'true';
    const req = {
      ip: '1.2.3.4',
      socket: { remoteAddress: '203.0.113.9' },
    };
    expect(keyGen(req)).toBe('203.0.113.9');
  });

  it('folds an IPv6 socket address to its /64 so a /64 cannot multiply buckets', () => {
    delete process.env.TRUST_PROXY;
    const reqA = { socket: { remoteAddress: '2001:db8:1:2:aaaa::1' } };
    const reqB = { socket: { remoteAddress: '2001:db8:1:2:bbbb::9' } };
    expect(keyGen(reqA)).toBe(keyGen(reqB)); // same /64 → same bucket
    expect(keyGen(reqA)).toBe('2001:db8:1:2::/64');
  });
});
