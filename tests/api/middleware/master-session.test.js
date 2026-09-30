// tests/api/middleware/master-session.test.js
// master-session.js exports ONE session middleware instance shared by
// master-auth.js and profit-addresses.js via the require cache. If either
// route called session() itself it would get a private MemoryStore and the
// three-step auth state set under /master-auth/* would be invisible to the
// other route. These tests pin the singleton contract.

const { masterSessionOptions } = require('../../../src/api/middleware/master-session');

describe('master-session shared singleton', () => {
  const MODULE = '../../../src/api/middleware/master-session';
  const SECRET_KEY = 'SESSION_SECRET';
  let savedSecret;
  let savedNodeEnv;

  beforeEach(() => {
    savedSecret = process.env[SECRET_KEY];
    savedNodeEnv = process.env.NODE_ENV;
    process.env[SECRET_KEY] = 'test-session-secret';
    jest.resetModules();
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env[SECRET_KEY];
    else process.env[SECRET_KEY] = savedSecret;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    jest.resetModules();
  });

  it('returns the same instance for every importer (shared MemoryStore)', () => {
    const a = require(MODULE).masterSession;
    const b = require(MODULE).masterSession;
    expect(a).toBe(b);
  });

  it('exports express-session middleware (callable)', () => {
    const { masterSession } = require(MODULE);
    expect(typeof masterSession).toBe('function');
  });

  it('fails fast in production when required secrets are missing', () => {
    delete process.env[SECRET_KEY];
    process.env.NODE_ENV = 'production';
    // config.js resolves JWT_SECRET first, so the thrown secret name varies;
    // the contract under test is production fail-fast, not which secret fires.
    expect(() => require(MODULE)).toThrow(/required secret/);
  });
});

describe('master-session config', () => {
  it('bounds the elevated session with an absolute TTL', () => {
    const { maxAge } = masterSessionOptions.cookie;
    expect(Number.isFinite(maxAge)).toBe(true);
    expect(maxAge).toBeGreaterThan(0);
    // 昇格セッションは長くても 1 時間以内に失効する
    expect(maxAge).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('keeps the hardened cookie attributes', () => {
    expect(masterSessionOptions.cookie.httpOnly).toBe(true);
    expect(masterSessionOptions.cookie.sameSite).toBe('strict');
    expect(masterSessionOptions.resave).toBe(false);
    expect(masterSessionOptions.saveUninitialized).toBe(false);
  });
});
