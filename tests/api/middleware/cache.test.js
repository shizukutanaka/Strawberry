// cache.js — レスポンスキャッシュミドルウェアのセキュリティ不変条件
// （perUser キー分離・非 2xx 非キャッシュ・invalidateUserCache の prefix 除去）
const { cacheMiddleware, cache, purgeCache, invalidateUserCache, invalidateByUrlPattern } = require('../../../src/api/middleware/cache');

function mockReq({ method = 'GET', url = '/api/orders', user } = {}) {
  return { method, originalUrl: url, user };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(k, v) { res.headers[k] = v; return res; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

function next() { return 'next-called'; }

describe('cacheMiddleware', () => {
  beforeEach(() => purgeCache());

  it('caches 2xx GET responses and serves them with X-Cache: HIT', () => {
    const mw = cacheMiddleware();
    const req = mockReq();
    const res1 = mockRes();
    mw(req, res1, () => next());
    res1.status(200).json({ orders: [1] });

    const res2 = mockRes();
    mw(req, res2, () => { throw new Error('handler should not run on cache hit'); });
    expect(res2.headers['X-Cache']).toBe('HIT');
    expect(res2.body).toEqual({ orders: [1] });
  });

  it('does NOT cache non-2xx responses', () => {
    const mw = cacheMiddleware();
    const req = mockReq();
    const res1 = mockRes();
    mw(req, res1, () => next());
    res1.status(500).json({ error: 'boom' });

    // Second request must run the handler again (no replay of the 500 body as 200).
    const res2 = mockRes();
    let ran = false;
    mw(req, res2, () => { ran = true; });
    expect(ran).toBe(true);
    expect(res2.headers['X-Cache']).toBeUndefined();
  });

  it('perUser: different users get separate cache entries', () => {
    const mw = cacheMiddleware({ perUser: true });
    const alice = mockReq({ user: { id: 'u-alice', role: 'user' } });
    const bob = mockReq({ user: { id: 'u-bob', role: 'user' } });

    const resA = mockRes();
    mw(alice, resA, () => next());
    resA.json({ mine: 'alice' });

    // Bob's request must miss — otherwise alice's orders would leak.
    const resB = mockRes();
    let ran = false;
    mw(bob, resB, () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('perUser: same user different role gets separate entries', () => {
    const mw = cacheMiddleware({ perUser: true });
    const asAdmin = mockReq({ user: { id: 'u-1', role: 'admin' } });
    const asUser = mockReq({ user: { id: 'u-1', role: 'user' } });

    const resA = mockRes();
    mw(asAdmin, resA, () => next());
    resA.json({ adminData: true });

    const resU = mockRes();
    let ran = false;
    mw(asUser, resU, () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('non-GET requests bypass the cache', () => {
    const mw = cacheMiddleware();
    const req = mockReq({ method: 'POST' });
    const res = mockRes();
    let ran = false;
    mw(req, res, () => { ran = true; });
    expect(ran).toBe(true);
    expect(cache.has(req.originalUrl)).toBe(false);
  });
});

describe('cache invalidation', () => {
  beforeEach(() => purgeCache());

  it('invalidateUserCache removes only that user\'s entries', () => {
    const mw = cacheMiddleware({ perUser: true });
    const alice = mockReq({ user: { id: 'u-alice', role: 'user' } });
    const bob = mockReq({ user: { id: 'u-bob', role: 'user' } });
    const resA = mockRes(); mw(alice, resA, () => next()); resA.json({ v: 'a' });
    const resB = mockRes(); mw(bob, resB, () => next()); resB.json({ v: 'b' });

    invalidateUserCache('u-alice');

    const resA2 = mockRes(); let ranA = false;
    mw(alice, resA2, () => { ranA = true; });
    expect(ranA).toBe(true);

    const resB2 = mockRes();
    mw(bob, resB2, () => { throw new Error('bob should hit cache'); });
    expect(resB2.headers['X-Cache']).toBe('HIT');
  });

  it('invalidateByUrlPattern removes matching keys', () => {
    const mw = cacheMiddleware();
    const req = mockReq({ url: '/api/gpus' });
    const res = mockRes(); mw(req, res, () => next()); res.json({ g: 1 });
    expect(cache.has('/api/gpus')).toBe(true);

    invalidateByUrlPattern('/api/gpus');
    expect(cache.has('/api/gpus')).toBe(false);
  });

  it('purgeCache clears everything', () => {
    const mw = cacheMiddleware();
    const res = mockRes(); mw(mockReq(), res, () => next()); res.json({ x: 1 });
    purgeCache();
    expect(cache.size).toBe(0);
  });
});
