// Provider reliability (uptime) tests.
//
// Increment: heartbeat persistence + reliability score. Two layers:
//  1. Unit — the scoring module (provider-uptime) computes measuring/score/tier
//     and detects disconnect "gap events" deterministically, without HTTP or the
//     heartbeat rate limiter in the way.
//  2. Integration — a real provider (lender) heartbeat on an active order persists
//     an uptime record and surfaces as `reliability` on the public GPU detail API,
//     without leaking the provider's identity.

const request = require('supertest');
const { app } = require('../../src/api/server');
const providerUptime = require('../../src/reputation/provider-uptime');
const UptimeRepository = require('../../src/db/json/UptimeRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

function cleanupProvider(providerId) {
  const rec = UptimeRepository.getByProviderId(providerId);
  if (rec) UptimeRepository.delete(rec.id);
}

describe('provider-uptime scoring (unit)', () => {
  beforeEach(() => providerUptime._resetVolatileState());

  it('reports measuring until the minimum beat sample is reached, then a score', () => {
    const pid = `unit-meas-${Date.now()}`;
    let t = 1_000_000;
    // A few beats — below MIN_BEATS_FOR_SCORE — should stay "measuring" (score null).
    for (let i = 0; i < 5; i++) { providerUptime.recordProviderHeartbeat(pid, 'o1', t); t += 10_000; }
    const early = providerUptime.getReliability(pid);
    expect(early.measuring).toBe(true);
    expect(early.score).toBeNull();
    expect(early.beats).toBe(5);

    // Cross the threshold with clean (no-gap) beats → perfect score.
    while (providerUptime.getReliability(pid).beats < providerUptime.MIN_BEATS_FOR_SCORE) {
      providerUptime.recordProviderHeartbeat(pid, 'o1', t); t += 10_000;
    }
    const scored = providerUptime.getReliability(pid);
    expect(scored.measuring).toBe(false);
    expect(scored.score).toBe(1);
    expect(scored.tier).toBe('excellent');

    cleanupProvider(pid);
  });

  it('counts a disconnect gap when a beat arrives after the gap threshold', () => {
    const pid = `unit-gap-${Date.now()}`;
    let t = 2_000_000;
    // Fill to threshold cleanly.
    for (let i = 0; i < providerUptime.MIN_BEATS_FOR_SCORE; i++) {
      providerUptime.recordProviderHeartbeat(pid, 'o1', t); t += 10_000;
    }
    const before = providerUptime.getReliability(pid);
    expect(before.gapEvents).toBe(0);
    expect(before.score).toBe(1);

    // Jump past the gap threshold → one disconnect event, score dips below 1.
    t += providerUptime.GAP_THRESHOLD_MS + 5_000;
    providerUptime.recordProviderHeartbeat(pid, 'o1', t);
    const after = providerUptime.getReliability(pid);
    expect(after.gapEvents).toBe(1);
    expect(after.score).toBeLessThan(1);

    cleanupProvider(pid);
  });

  it('returns an unrated summary for an unknown provider', () => {
    const rel = providerUptime.getReliability(`nobody-${Date.now()}`);
    expect(rel.score).toBeNull();
    expect(rel.tier).toBe('unrated');
    expect(rel.beats).toBe(0);
  });
});

describe('provider reliability surfaces via the GPU API (integration)', () => {
  it('persists a provider heartbeat and exposes reliability without leaking identity', async () => {
    providerUptime._resetVolatileState();
    const u = `reliprov${Date.now().toString(36)}`.slice(0, 20);
    await request(app).post('/api/v1/users/register')
      .send({ username: u, email: `${u}@example.com`, password: 'Test1234!', role: 'provider' });
    const login = await request(app).post('/api/v1/users/login')
      .send({ email: `${u}@example.com`, password: 'Test1234!' });
    const token = login.body.token;
    const providerId = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`).id;

    const gpu = GpuRepository.create({
      name: 'Reliability GPU', vendor: 'NVIDIA', model: 'RTX-REL', memoryGB: 8,
      pricePerHour: 10, providerId,
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId: 'some-renter', providerId,
      status: 'active', durationMinutes: 60, pricePerHour: 10, totalPrice: 10,
    });

    // A single provider (lender) heartbeat should create an uptime record.
    const hb = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'lender' });
    expect(hb.statusCode).toBe(200);

    const rec = UptimeRepository.getByProviderId(providerId);
    expect(rec).toBeTruthy();
    expect(rec.beats).toBe(1);

    // Public GPU detail (unauthenticated) exposes the reliability summary but not providerId.
    const detail = await request(app).get(`/api/v1/gpus/${gpu.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.gpu.reliability).toBeTruthy();
    expect(detail.body.gpu.reliability).toHaveProperty('tier');
    expect(detail.body.gpu.providerId).toBeUndefined(); // identity stays hidden
    // 1 beat < threshold → still measuring.
    expect(detail.body.gpu.reliability.score).toBeNull();
    expect(detail.body.gpu.reliability.measuring).toBe(true);

    cleanupProvider(providerId);
  });
});
