// Regression: PUT /orders/:id and DELETE /orders/:id must be restricted to the
// order creator (renter) and admins. A GPU provider was previously admitted by
// allowOwnerOrAdmin via order.providerId, letting them:
//   - PUT: silently overwrite the renter's description/notes (evidence tampering)
//   - DELETE: forge a 'user_cancelled' soft-cancel, forfeiting the renter's escrow
// Providers have dedicated endpoints (/accept, /reject) for their legitimate actions.
const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!' });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  const user = UserRepository.getByEmail(email);
  return { token: res.body.token, id: user.id };
}

describe('Order provider-mutation authorization', () => {
  let renter, provider, gpuId, order;

  beforeAll(async () => {
    renter = await registerAndLogin('opmr');
    provider = await registerAndLogin('opmp');

    gpuId = GpuRepository.create({
      name: 'Auth Test GPU', vendor: 'NVIDIA', model: 'RTX-A', memoryGB: 8, pricePerHour: 50,
    }).id;

    // Create an order owned by the renter and assign the provider to it directly.
    order = OrderRepository.create({
      userId: renter.id,
      providerId: provider.id,
      gpuId,
      durationMinutes: 60,
      status: 'pending',
      totalPrice: 50,
      pricePerHour: 50,
    });
  });

  it('renter can PUT their own order (200)', async () => {
    const res = await request(app).put(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ description: 'renter update' });
    expect(res.statusCode).toBe(200);
  });

  it('provider cannot PUT the renter\'s order (403)', async () => {
    const res = await request(app).put(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ description: 'provider tampering' });
    expect(res.statusCode).toBe(403);
    // Verify the renter's description was NOT overwritten
    const stored = OrderRepository.getById(order.id);
    expect(stored.description).not.toBe('provider tampering');
  });

  it('provider cannot DELETE (soft-cancel) the renter\'s order (403)', async () => {
    const res = await request(app).delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${provider.token}`);
    expect(res.statusCode).toBe(403);
    // Order must remain in its original status
    expect(OrderRepository.getById(order.id).status).toBe('pending');
  });

  it('renter can DELETE (self-cancel) their own pending order (200)', async () => {
    const res = await request(app).delete(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.statusCode).toBe(200);
    expect(OrderRepository.getById(order.id).status).toBe('cancelled');
    expect(OrderRepository.getById(order.id).cancelReason).toBe('user_cancelled');
  });
});
