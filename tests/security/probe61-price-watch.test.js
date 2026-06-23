// tests/security/probe61-price-watch.test.js
// Probe 61 (GPU price-drop watch): renters can register a target price on a GPU
// and receive a notification when the price drops to or below their target.
// Security invariants:
//   - Unauthenticated requests are rejected (401)
//   - Providers cannot watch their own GPUs (403)
//   - notifyPriceWatchers does not fire on price increases or same price
//   - lastNotifiedPrice suppresses re-notification at the same/higher price

const request = require('supertest');
const { app } = require('../../src/api/server');
const { notifyPriceWatchers, notifyWatchJustCreated } = require('../../src/services/price-watch');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

let _userCounter = 0;
// Register a user (username + Test1234!) and return { token, id }. Login returns `token`.
async function registerAndLogin(prefix) {
  const uniq = `${prefix}${Date.now().toString(36)}${_userCounter++}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);
  const password = 'Test1234!';
  await request(app).post('/api/v1/users/register').send({ username, email, password });
  const res = await request(app).post('/api/v1/users/login').send({ email, password });
  const u = UserRepository.getByEmail(email);
  return { token: res.body.token, id: u ? u.id : null };
}

// Seed a GPU directly via the repository (bypasses attestation/role gating that the
// POST /gpus endpoint enforces — we only need a persisted GPU owned by providerId).
function createGpu(providerId, price = 2.5) {
  return GpuRepository.create({
    name: `TestGPU-${Date.now()}-${_userCounter++}`,
    model: 'A100',
    vendor: 'NVIDIA',
    memoryGB: 80,
    pricePerHour: price,
    providerId,
    available: true,
  });
}

// ── notifyPriceWatchers unit tests ─────────────────────────────────────────

describe('notifyPriceWatchers unit', () => {
  function makeGpu(overrides) {
    return { id: 'gpu-1', name: 'G1', pricePerHour: 1.0, providerId: 'provider-1', ...overrides };
  }

  function makeWatch(overrides) {
    return { id: 'w1', userId: 'user-1', gpuId: 'gpu-1', targetPrice: 1.5, lastNotifiedPrice: null, ...overrides };
  }

  it('returns 0 when gpu is null', () => {
    expect(notifyPriceWatchers(null, 2.0)).toBe(0);
  });

  it('returns 0 when price did not drop', () => {
    const gpu = makeGpu({ pricePerHour: 2.0 });
    const repo = { getByGpu: () => [makeWatch()] };
    const notify = jest.fn();
    expect(notifyPriceWatchers(gpu, 2.0, { repo, notify })).toBe(0);
    expect(notifyPriceWatchers(gpu, 1.5, { repo, notify })).toBe(0); // price went up
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies when price drops to or below targetPrice', () => {
    const gpu = makeGpu({ pricePerHour: 1.0 });
    const watches = [makeWatch({ targetPrice: 1.5, lastNotifiedPrice: null })];
    const repo = {
      getByGpu: () => watches,
      update: jest.fn(),
    };
    const notify = jest.fn();
    const count = notifyPriceWatchers(gpu, 2.0, { repo, notify });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('gpu_price_drop');
  });

  it('does not notify when new price is still above targetPrice', () => {
    const gpu = makeGpu({ pricePerHour: 2.0 });
    const watches = [makeWatch({ targetPrice: 1.5 })];
    const repo = { getByGpu: () => watches };
    const notify = jest.fn();
    expect(notifyPriceWatchers(gpu, 3.0, { repo, notify })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when provider watches their own GPU', () => {
    const gpu = makeGpu({ pricePerHour: 1.0, providerId: 'user-1' });
    const watches = [makeWatch({ userId: 'user-1', targetPrice: 2.0 })];
    const repo = { getByGpu: () => watches };
    const notify = jest.fn();
    expect(notifyPriceWatchers(gpu, 2.0, { repo, notify })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when the GPU is not rentable (available === false)', () => {
    // New viewpoint: an alert is only valuable if the GPU can actually be rented.
    // A drop on an available:false GPU is a false signal (it is hidden from the
    // marketplace), so it must be suppressed even though price and target match.
    const gpu = makeGpu({ pricePerHour: 1.0, available: false });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const notify = jest.fn();
    const repo = { getByGpu: () => watches, update: jest.fn() };
    expect(notifyPriceWatchers(gpu, 3.0, { repo, notify })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('still notifies when available is undefined (legacy GPUs default to rentable)', () => {
    // available !== false is the marketplace's "rentable" predicate, so a GPU with
    // no available field must NOT be treated as unavailable.
    const gpu = makeGpu({ pricePerHour: 1.0 }); // no `available` key
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const notify = jest.fn();
    const repo = { getByGpu: () => watches, update: jest.fn() };
    expect(notifyPriceWatchers(gpu, 3.0, { repo, notify })).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('suppresses re-notification when lastNotifiedPrice <= newPrice', () => {
    const gpu = makeGpu({ pricePerHour: 1.0 });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: 1.0 })];
    const repo = { getByGpu: () => watches };
    const notify = jest.fn();
    expect(notifyPriceWatchers(gpu, 3.0, { repo, notify })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('re-notifies when price drops further below lastNotifiedPrice', () => {
    const gpu = makeGpu({ pricePerHour: 0.5 });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: 1.0 })];
    const repo = {
      getByGpu: () => watches,
      update: jest.fn(),
    };
    const notify = jest.fn();
    const count = notifyPriceWatchers(gpu, 3.0, { repo, notify });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  // ── Availability-restore path ──────────────────────────────────────────

  it('notifies on availability restore when price is already at or below target', () => {
    // Scenario: provider dropped price while GPU was offline, then brought it back.
    // The price-drop event was suppressed (available:false). The restore event must
    // fire so the watcher is not silently locked out of an actionable opportunity.
    const gpu = makeGpu({ pricePerHour: 1.0, available: true });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const repo = { getByGpu: () => watches, update: jest.fn() };
    const notify = jest.fn();
    // Pass previousAvailable:false to signal restore event (price unchanged)
    const count = notifyPriceWatchers(gpu, { previousPrice: 1.0, previousAvailable: false }, { repo, notify });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('gpu_available_restored');
  });

  it('no notification on availability restore when price is still above target', () => {
    const gpu = makeGpu({ pricePerHour: 3.0, available: true });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const repo = { getByGpu: () => watches };
    const notify = jest.fn();
    expect(notifyPriceWatchers(gpu, { previousPrice: 3.0, previousAvailable: false }, { repo, notify })).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('availability restore ignores lastNotifiedPrice suppression (offline broke actionability)', () => {
    // Watcher was previously notified at price 1.0. GPU went offline, came back at same price.
    // Price-drop path would suppress (lastNotifiedPrice 1.0 <= newPrice 1.0).
    // Availability-restore path must NOT suppress — GPU being offline means the prior
    // notification window was lost; restore is independently actionable.
    const gpu = makeGpu({ pricePerHour: 1.0, available: true });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: 1.0 })];
    const repo = { getByGpu: () => watches, update: jest.fn() };
    const notify = jest.fn();
    const count = notifyPriceWatchers(gpu, { previousPrice: 1.0, previousAvailable: false }, { repo, notify });
    expect(count).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('when both isPriceDrop and isAvailabilityRestore, uses gpu_price_drop event type', () => {
    // Price dropped AND GPU became available simultaneously.
    const gpu = makeGpu({ pricePerHour: 1.0, available: true });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const repo = { getByGpu: () => watches, update: jest.fn() };
    const notify = jest.fn();
    notifyPriceWatchers(gpu, { previousPrice: 2.5, previousAvailable: false }, { repo, notify });
    expect(notify.mock.calls[0][1]).toBe('gpu_price_drop');
  });

  it('backward compatible with numeric previousInfo (legacy callers)', () => {
    const gpu = makeGpu({ pricePerHour: 1.0 });
    const watches = [makeWatch({ targetPrice: 2.0, lastNotifiedPrice: null })];
    const repo = { getByGpu: () => watches, update: jest.fn() };
    const notify = jest.fn();
    // Old call style: notifyPriceWatchers(gpu, 2.5, deps)
    expect(notifyPriceWatchers(gpu, 2.5, { repo, notify })).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('updates lastNotifiedPrice and lastNotifiedAt after notification', () => {
    const gpu = makeGpu({ pricePerHour: 1.0 });
    const watches = [makeWatch({ id: 'w99', targetPrice: 2.0, lastNotifiedPrice: null })];
    const updateSpy = jest.fn();
    const repo = {
      getByGpu: () => watches,
      update: updateSpy,
    };
    notifyPriceWatchers(gpu, 3.0, { repo, notify: jest.fn() });
    expect(updateSpy).toHaveBeenCalledWith('w99', expect.objectContaining({ lastNotifiedPrice: 1.0 }));
    expect(updateSpy.mock.calls[0][1].lastNotifiedAt).toBeDefined();
  });

  it('repo.getByGpu failure returns 0 without throwing', () => {
    const gpu = makeGpu({ pricePerHour: 1.0 });
    const repo = { getByGpu: () => { throw new Error('disk error'); } };
    expect(() => notifyPriceWatchers(gpu, 2.0, { repo, notify: jest.fn() })).not.toThrow();
    expect(notifyPriceWatchers(gpu, 2.0, { repo, notify: jest.fn() })).toBe(0);
  });
});

// ── notifyWatchJustCreated unit tests ─────────────────────────────────────

describe('notifyWatchJustCreated unit', () => {
  function makeGpu(overrides) {
    return { id: 'gpu-1', name: 'G1', pricePerHour: 1.0, providerId: 'provider-1', available: true, ...overrides };
  }
  function makeWatch(overrides) {
    return { id: 'w1', userId: 'user-1', gpuId: 'gpu-1', targetPrice: 2.0, ...overrides };
  }

  it('returns false when gpu is null', () => {
    expect(notifyWatchJustCreated(null, makeWatch())).toBe(false);
  });

  it('returns false when watch is null', () => {
    expect(notifyWatchJustCreated(makeGpu(), null)).toBe(false);
  });

  it('notifies (true) when price is already at or below targetPrice', () => {
    // Core scenario: GPU is $1.00, watcher sets target $2.00 → already met → immediate alert
    const notify = jest.fn();
    const repo = { update: jest.fn() };
    const result = notifyWatchJustCreated(makeGpu({ pricePerHour: 1.0 }), makeWatch({ targetPrice: 2.0 }), { repo, notify });
    expect(result).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('gpu_watch_price_already_met');
  });

  it('notifies when price exactly equals targetPrice', () => {
    const notify = jest.fn();
    const repo = { update: jest.fn() };
    expect(notifyWatchJustCreated(makeGpu({ pricePerHour: 2.0 }), makeWatch({ targetPrice: 2.0 }), { repo, notify })).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not notify when price is above targetPrice (watch not yet triggered)', () => {
    const notify = jest.fn();
    expect(notifyWatchJustCreated(makeGpu({ pricePerHour: 3.0 }), makeWatch({ targetPrice: 2.0 }), { notify })).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when GPU is unavailable (available === false)', () => {
    const notify = jest.fn();
    expect(notifyWatchJustCreated(
      makeGpu({ pricePerHour: 1.0, available: false }),
      makeWatch({ targetPrice: 2.0 }),
      { notify }
    )).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when watcher is the provider (self-watch guard)', () => {
    const notify = jest.fn();
    expect(notifyWatchJustCreated(
      makeGpu({ pricePerHour: 1.0, providerId: 'user-1' }),
      makeWatch({ userId: 'user-1', targetPrice: 2.0 }),
      { notify }
    )).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('updates lastNotifiedPrice after immediate notification', () => {
    const updateSpy = jest.fn();
    const repo = { update: updateSpy };
    notifyWatchJustCreated(makeGpu({ pricePerHour: 1.0 }), makeWatch({ id: 'w42', targetPrice: 2.0 }), { repo, notify: jest.fn() });
    expect(updateSpy).toHaveBeenCalledWith('w42', expect.objectContaining({ lastNotifiedPrice: 1.0 }));
  });
});

// ── Watch API integration tests ────────────────────────────────────────────

describe('POST /api/v1/gpus/:id/watch', () => {
  let provider, renter, providerToken, renterToken, gpu;

  beforeAll(async () => {
    provider = await registerAndLogin('prov61a');
    renter = await registerAndLogin('rent61a');
    providerToken = provider.token;
    renterToken = renter.token;
    gpu = createGpu(provider.id, 3.0);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .send({ targetPrice: 2.0 });
    expect(res.status).toBe(401);
  });

  it('returns 403 when provider watches their own GPU', async () => {
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${providerToken}`)
      .send({ targetPrice: 2.0 });
    expect(res.status).toBe(403);
  });

  it('returns 400 when targetPrice is missing', async () => {
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when targetPrice is not positive', async () => {
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: -1 });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent GPU', async () => {
    const res = await request(app)
      .post('/api/v1/gpus/00000000-0000-4000-8000-000000000000/watch')
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 2.0 });
    expect(res.status).toBe(404);
  });

  it('creates a watch successfully (201)', async () => {
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 2.0 });
    expect(res.status).toBe(201);
    expect(res.body.watch).toBeDefined();
    expect(res.body.watch.targetPrice).toBe(2.0);
    expect(res.body.watch.gpuId).toBe(gpu.id);
  });

  it('upserts an existing watch (200)', async () => {
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 1.8 });
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.watch.targetPrice).toBe(1.5);
  });

  it('watch response 201 even when GPU price already meets targetPrice (immediate-notify path)', async () => {
    // Scenario: GPU is at $3.00, renter sets targetPrice $5.00 (GPU is already below target).
    // The POST must still return 201 (fire-and-forget notifyWatchJustCreated runs async).
    const provider2 = await registerAndLogin('prov61imm');
    const renter2 = await registerAndLogin('rent61imm');
    const cheapGpu = createGpu(provider2.id, 1.0); // price $1.00
    const res = await request(app)
      .post(`/api/v1/gpus/${cheapGpu.id}/watch`)
      .set('Authorization', `Bearer ${renter2.token}`)
      .send({ targetPrice: 5.0 }); // target well above current price
    expect(res.status).toBe(201);
    expect(res.body.watch.targetPrice).toBe(5.0);
    // notifyWatchJustCreated ran in setImmediate; lastNotifiedPrice is set asynchronously.
    // We cannot assert on it synchronously here, but the route must not error.
  });
});

describe('GET /api/v1/gpus/:id/watch', () => {
  let renterToken, gpu;

  beforeAll(async () => {
    const provider = await registerAndLogin('prov61g');
    const renter = await registerAndLogin('rent61g');
    renterToken = renter.token;
    gpu = createGpu(provider.id, 3.0);
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 2.0 });
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get(`/api/v1/gpus/${gpu.id}/watch`);
    expect(res.status).toBe(401);
  });

  it('returns the watch for the authenticated user', async () => {
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`);
    expect(res.status).toBe(200);
    expect(res.body.watch.gpuId).toBe(gpu.id);
  });

  it('returns 404 when no watch exists for the user', async () => {
    const other = await registerAndLogin('other61g');
    const res = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/gpus/:id/watch', () => {
  let renterToken, gpu;

  beforeAll(async () => {
    const provider = await registerAndLogin('prov61d');
    const renter = await registerAndLogin('rent61d');
    renterToken = renter.token;
    gpu = createGpu(provider.id, 3.0);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).delete(`/api/v1/gpus/${gpu.id}/watch`);
    expect(res.status).toBe(401);
  });

  it('returns 404 when watch does not exist', async () => {
    const res = await request(app)
      .delete(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`);
    expect(res.status).toBe(404);
  });

  it('removes an existing watch (200)', async () => {
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 2.0 });
    const res = await request(app)
      .delete(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`);
    expect(res.status).toBe(200);
    // subsequent GET returns 404
    const getRes = await request(app)
      .get(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`);
    expect(getRes.status).toBe(404);
  });
});

describe('GET /api/v1/users/me/watches', () => {
  let renterToken, gpu1, gpu2;

  beforeAll(async () => {
    const provider = await registerAndLogin('prov61m');
    const renter = await registerAndLogin('rent61m');
    renterToken = renter.token;
    gpu1 = createGpu(provider.id, 3.0);
    gpu2 = createGpu(provider.id, 4.0);
    await request(app)
      .post(`/api/v1/gpus/${gpu1.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 1.5 });
    await request(app)
      .post(`/api/v1/gpus/${gpu2.id}/watch`)
      .set('Authorization', `Bearer ${renterToken}`)
      .send({ targetPrice: 2.0 });
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/users/me/watches');
    expect(res.status).toBe(401);
  });

  it('returns enriched watches with GPU snapshot (N+1 elimination)', async () => {
    const res = await request(app)
      .get('/api/v1/users/me/watches')
      .set('Authorization', `Bearer ${renterToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.watches)).toBe(true);
    expect(res.body.watches.length).toBeGreaterThanOrEqual(2);
    const w1 = res.body.watches.find(w => w.gpuId === gpu1.id);
    const w2 = res.body.watches.find(w => w.gpuId === gpu2.id);
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    // Each watch must include an enriched gpu snapshot
    expect(w1.gpu).toMatchObject({ id: gpu1.id, pricePerHour: 3.0 });
    expect(w2.gpu).toMatchObject({ id: gpu2.id, pricePerHour: 4.0 });
    // available must be normalized to an explicit boolean (not undefined/null).
    // The marketplace uses available!==false as the rentable predicate; clients
    // that test ===true would wrongly mark legacy GPUs as non-rentable without normalization.
    expect(typeof w1.gpu.available).toBe('boolean');
    expect(typeof w2.gpu.available).toBe('boolean');
    // Sensitive fields must be absent from the gpu snapshot
    expect(w1.gpu).not.toHaveProperty('apiKey');
    expect(w1.gpu).not.toHaveProperty('providerId');
  });

  it('returns gpu:null for watches on deleted GPUs (orphan handling)', async () => {
    const WatchRepository = require('../../src/db/json/WatchRepository');
    const { v4: uuidv4 } = require('uuid');
    const provider = await registerAndLogin('prov61null');
    const renter = await registerAndLogin('rent61null');
    const deletedGpuId = uuidv4(); // never actually exists
    // Seed a watch for a non-existent GPU directly (simulates orphan after delete)
    WatchRepository.create({
      userId: renter.id,
      gpuId: deletedGpuId,
      targetPrice: 1.0,
      lastNotifiedPrice: null,
      lastNotifiedAt: null,
      createdAt: new Date().toISOString(),
    });
    const res = await request(app)
      .get('/api/v1/users/me/watches')
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.status).toBe(200);
    const orphan = res.body.watches.find(w => w.gpuId === deletedGpuId);
    expect(orphan).toBeDefined();
    expect(orphan.gpu).toBeNull(); // graceful null — no 404 needed
  });
});

// ── Hardening: per-user cap + orphan cleanup ───────────────────────────────

describe('watch resource limits and lifecycle', () => {
  const WatchRepository = require('../../src/db/json/WatchRepository');
  const GpuRepo = require('../../src/db/json/GpuRepository');

  it('enforces a per-user watch cap (429) and does not persist the over-limit watch', async () => {
    const provider = await registerAndLogin('provcap');
    const renter = await registerAndLogin('rentcap');
    // Seed the user at the cap directly in the repo (fast — avoids 200 HTTP calls).
    const MAX = 200;
    for (let i = 0; i < MAX; i++) {
      WatchRepository.create({
        userId: renter.id,
        gpuId: `seed-${renter.id}-${i}`,
        targetPrice: 1.0,
        lastNotifiedPrice: null,
        lastNotifiedAt: null,
        createdAt: new Date().toISOString(),
      });
    }
    const gpu = createGpu(provider.id, 3.0);
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ targetPrice: 2.0 });
    expect(res.status).toBe(429);
    // The new GPU must not have produced a persisted watch.
    const after = WatchRepository.getByUser(renter.id) || [];
    expect(after.find(w => w.gpuId === gpu.id)).toBeUndefined();
    expect(after.length).toBe(MAX);
  });

  it('upsert at the cap still succeeds (does not count against the limit)', async () => {
    const provider = await registerAndLogin('provcap2');
    const renter = await registerAndLogin('rentcap2');
    const gpu = createGpu(provider.id, 3.0);
    // One real watch on the target GPU.
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ targetPrice: 2.0 });
    // Fill the rest up to the cap.
    for (let i = 0; i < 199; i++) {
      WatchRepository.create({
        userId: renter.id,
        gpuId: `seed2-${renter.id}-${i}`,
        targetPrice: 1.0,
        createdAt: new Date().toISOString(),
      });
    }
    // Re-POST the same GPU → upsert, must succeed (200) even though at cap.
    const res = await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ targetPrice: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.watch.targetPrice).toBe(1.5);
  });

  it('deleting a GPU cleans up its orphaned watches', async () => {
    const provider = await registerAndLogin('provorph');
    const renter1 = await registerAndLogin('rentorph1');
    const renter2 = await registerAndLogin('rentorph2');
    const gpu = createGpu(provider.id, 3.0);
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renter1.token}`)
      .send({ targetPrice: 2.0 });
    await request(app)
      .post(`/api/v1/gpus/${gpu.id}/watch`)
      .set('Authorization', `Bearer ${renter2.token}`)
      .send({ targetPrice: 1.5 });
    expect((WatchRepository.getByGpu(gpu.id) || []).length).toBe(2);

    // Owner deletes the GPU.
    const del = await request(app)
      .delete(`/api/v1/gpus/${gpu.id}`)
      .set('Authorization', `Bearer ${provider.token}`);
    expect(del.status).toBe(200);
    // Orphaned watches for that GPU must be gone.
    expect((WatchRepository.getByGpu(gpu.id) || []).length).toBe(0);
  });

  it('deactivating a user account cleans up that user\'s watches', async () => {
    // Symmetric counterpart to GPU-delete cleanup: a deactivated user can never
    // log in again, so their watches are dead weight that also waste notify cycles.
    const provider = await registerAndLogin('provdeact');
    const renter = await registerAndLogin('rentdeact');
    const gpu1 = createGpu(provider.id, 3.0);
    const gpu2 = createGpu(provider.id, 4.0);
    await request(app)
      .post(`/api/v1/gpus/${gpu1.id}/watch`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ targetPrice: 2.0 });
    await request(app)
      .post(`/api/v1/gpus/${gpu2.id}/watch`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ targetPrice: 2.5 });
    expect((WatchRepository.getByUser(renter.id) || []).length).toBe(2);

    // User deletes (deactivates) their own account.
    const del = await request(app)
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${renter.token}`);
    expect(del.status).toBe(200);
    // The user's watches must be gone.
    expect((WatchRepository.getByUser(renter.id) || []).length).toBe(0);
  });
});
