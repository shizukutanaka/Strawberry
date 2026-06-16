// Regression: order creation must enforce a global per-user pending order cap
// (MAX_PENDING_ORDERS_PER_USER env, default 50) in addition to the per-GPU cap of 5.
// Without the global cap, an attacker can create 5 × N pending orders across N GPUs
// causing storage exhaustion and O(n) scan DoS on every OrderRepository.getAll() call.
const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Cap1234!' });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Cap1234!' });
  const user = UserRepository.getByEmail(email);
  return { token: res.body.token, id: user.id };
}

describe('Global per-user pending order cap', () => {
  const ORIG_ENV = process.env.MAX_PENDING_ORDERS_PER_USER;

  // Use a dedicated GPU provider so renters never trigger the self-order guard.
  let provider;

  beforeAll(async () => {
    process.env.MAX_PENDING_ORDERS_PER_USER = '3';
    provider = await registerAndLogin('gcprov');
  });

  afterAll(() => {
    if (ORIG_ENV === undefined) delete process.env.MAX_PENDING_ORDERS_PER_USER;
    else process.env.MAX_PENDING_ORDERS_PER_USER = ORIG_ENV;
  });

  it('rejects a new order when user has hit the global pending cap across different GPUs', async () => {
    const renter = await registerAndLogin('gcap');

    // Create 4 GPUs owned by the provider (never the renter, to avoid self-order guard).
    const gpu1 = GpuRepository.create({ name: 'Cap GPU 1', vendor: 'NVIDIA', model: 'A100', memoryGB: 40, pricePerHour: 10, providerId: provider.id }).id;
    const gpu2 = GpuRepository.create({ name: 'Cap GPU 2', vendor: 'AMD', model: 'MI250', memoryGB: 64, pricePerHour: 8, providerId: provider.id }).id;
    const gpu3 = GpuRepository.create({ name: 'Cap GPU 3', vendor: 'NVIDIA', model: 'H100', memoryGB: 80, pricePerHour: 12, providerId: provider.id }).id;
    const gpu4 = GpuRepository.create({ name: 'Cap GPU 4', vendor: 'Intel', model: 'A770', memoryGB: 16, pricePerHour: 5, providerId: provider.id }).id;

    // Inject 3 pending orders (one per GPU) for the renter directly into the repo to hit the cap.
    const base = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    OrderRepository.create({ userId: renter.id, gpuId: gpu1, durationMinutes: 5, status: 'pending', totalPrice: 1, scheduledStartAt: base, scheduledEndAt: base });
    OrderRepository.create({ userId: renter.id, gpuId: gpu2, durationMinutes: 5, status: 'pending', totalPrice: 1, scheduledStartAt: base, scheduledEndAt: base });
    OrderRepository.create({ userId: renter.id, gpuId: gpu3, durationMinutes: 5, status: 'pending', totalPrice: 1, scheduledStartAt: base, scheduledEndAt: base });

    // Attempting a 4th order (on gpu4, a different GPU) must be rejected with the global cap error.
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu4, durationMinutes: 5 });

    expect(res.statusCode).toBe(409);
    // Error body is { error: { message, type, ... } } from the error middleware.
    const errMsg = (res.body.error && res.body.error.message) || res.body.message || '';
    expect(errMsg).toMatch(/global limit/i);
  });

  it('allows a new order when user is below the global cap', async () => {
    const renter = await registerAndLogin('gcap2');
    const gpu1 = GpuRepository.create({ name: 'Cap GPU OK1', vendor: 'NVIDIA', model: 'RTX4090', memoryGB: 24, pricePerHour: 3, providerId: provider.id }).id;
    const gpu2 = GpuRepository.create({ name: 'Cap GPU OK2', vendor: 'AMD', model: 'RX7900', memoryGB: 20, pricePerHour: 2, providerId: provider.id }).id;

    // Only 2 blocking orders → below the cap of 3.
    const base = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    OrderRepository.create({ userId: renter.id, gpuId: gpu1, durationMinutes: 5, status: 'pending', totalPrice: 1, scheduledStartAt: base, scheduledEndAt: base });
    OrderRepository.create({ userId: renter.id, gpuId: gpu1, durationMinutes: 5, status: 'active', totalPrice: 1, scheduledStartAt: base, scheduledEndAt: base });

    // 3rd order on a fresh GPU should succeed (still within the cap of 3).
    const res = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ gpuId: gpu2, durationMinutes: 5 });

    expect([200, 201]).toContain(res.statusCode);
  });
});
