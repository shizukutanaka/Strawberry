// Usage-session memory-leak reaping tests.
//
// OrderUsageSession objects are created on heartbeat and were previously only
// removed by the /stop handler. Orders that reach a terminal state via any other
// path (delete, reject, dispute-resolve) — or that are deleted outright — would
// otherwise leak their session forever. The periodic reaper evicts sessions whose
// order is terminal or missing, and the heartbeat endpoint refuses terminal orders.

const request = require('supertest');
const { app } = require('../../src/api/server');
const orderRouter = require('../../src/api/routes/order');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const sessions = orderRouter._usageSessions;
const reap = orderRouter._reapUsageSessions;
const OrderUsageSession = orderRouter._OrderUsageSession;

describe('usage-session reaping prevents memory leaks', () => {
  it('reaps sessions for completed and cancelled orders, keeps active ones', () => {
    const activeOrder = OrderRepository.create({ status: 'active', durationMinutes: 60 });
    const completedOrder = OrderRepository.create({ status: 'completed', durationMinutes: 60 });
    const cancelledOrder = OrderRepository.create({ status: 'cancelled', durationMinutes: 60 });

    sessions.set(activeOrder.id, new OrderUsageSession(activeOrder.id, 'p', 'r'));
    sessions.set(completedOrder.id, new OrderUsageSession(completedOrder.id, 'p', 'r'));
    sessions.set(cancelledOrder.id, new OrderUsageSession(cancelledOrder.id, 'p', 'r'));

    reap();

    expect(sessions.has(activeOrder.id)).toBe(true);     // still active → kept
    expect(sessions.has(completedOrder.id)).toBe(false); // terminal → reaped
    expect(sessions.has(cancelledOrder.id)).toBe(false); // terminal → reaped

    sessions.delete(activeOrder.id); // cleanup
  });

  it('reaps orphaned sessions whose order no longer exists', () => {
    const orphanId = 'nonexistent-order-id-12345';
    sessions.set(orphanId, new OrderUsageSession(orphanId, 'p', 'r'));

    reap();

    expect(sessions.has(orphanId)).toBe(false); // missing order → reaped
  });

  it('rejects heartbeats for a completed order (409) and creates no session', async () => {
    // Set up a real renter + provider + GPU + completed order
    const u = `hbreap${Date.now().toString(36)}`.slice(0, 20);
    await request(app).post('/api/v1/users/register')
      .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
    const login = await request(app).post('/api/v1/users/login')
      .send({ email: `${u}@example.com`, password: 'Test1234!' });
    const token = login.body.token;
    const userId = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`).id;

    const gpu = GpuRepository.create({
      name: 'HB GPU', vendor: 'NVIDIA', model: 'RTX-HB', memoryGB: 8,
      pricePerHour: 10, providerId: 'someprovider',
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId, providerId: 'someprovider',
      status: 'completed', durationMinutes: 60, pricePerHour: 10, totalPrice: 10,
    });

    const res = await request(app).post(`/api/v1/orders/${order.id}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'renter' });

    expect(res.statusCode).toBe(409);
    expect(sessions.has(order.id)).toBe(false); // no session created for terminal order
  });
});
