// Regression tests for the money-critical manual-payment-approval guards in
// src/api/routes/payment/index.js. These rules (lightning can't be manually
// approved, only pending/matched orders accept approval, a payment can't be
// double-approved, admin-only access) were documented in the route but only
// the happy path was covered — through the admin-payments E2E spec, not at the
// faster jest layer. Each guard is locked in here as a direct regression test.
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `payapprove${Date.now().toString(36)}`;

async function registerAndLogin(prefix, role) {
  const u = `${prefix}${uniq}`.slice(0, 28);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!', ...(role ? { role } : {}) });
  const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(email)?.id, email };
}

async function makeAdmin(prefix) {
  const u = `${prefix}${uniq}`.slice(0, 28);
  const email = `${u}@example.com`.toLowerCase();
  await request(app).post('/api/v1/users/register').send({ username: u, email, password: 'Test1234!' });
  // Admin is assigned out of band (no self-service escalation API); set the role
  // directly then log in so the JWT carries role:admin.
  const rec = UserRepository.getByEmail(email);
  UserRepository.update(rec.id, { role: 'admin' });
  const login = await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' });
  return { token: login.body.token, id: rec.id };
}

async function newBankTransferPayment(renter, provider) {
  const gpuId = GpuRepository.create({
    name: 'Approve GPU', vendor: 'NVIDIA', model: 'RTX-APP', memoryGB: 16,
    pricePerHour: 1200, providerId: provider.id, available: true,
  }).id;
  const orderRes = await request(app).post('/api/v1/orders')
    .set('Authorization', `Bearer ${renter.token}`).send({ gpuId, durationMinutes: 60 });
  const orderId = orderRes.body.orderId || orderRes.body.order?.id;
  await request(app).post(`/api/v1/orders/${orderId}/accept`).set('Authorization', `Bearer ${provider.token}`);
  const payRes = await request(app).post(`/api/v1/payments/order/${orderId}`)
    .set('Authorization', `Bearer ${renter.token}`).send({ paymentMethod: 'bank_transfer' });
  return { gpuId, orderId, paymentId: payRes.body.paymentId };
}

describe('manual payment approval guards', () => {
  let renter, provider, admin;

  beforeAll(async () => {
    renter = await registerAndLogin('rent');
    provider = await registerAndLogin('prov', 'provider');
    admin = await makeAdmin('adm');
  });

  it('lists the pending bank-transfer payment for an admin, but 403s a non-admin', async () => {
    const { paymentId } = await newBankTransferPayment(renter, provider);
    const adminList = await request(app).get('/api/v1/payments/admin/pending')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(adminList.statusCode).toBe(200);
    expect(adminList.body.payments.some((p) => p.id === paymentId)).toBe(true);

    const renterList = await request(app).get('/api/v1/payments/admin/pending')
      .set('Authorization', `Bearer ${renter.token}`);
    expect(renterList.statusCode).toBe(403);
  });

  it('shows the payment in the renter\'s own history', async () => {
    const { paymentId } = await newBankTransferPayment(renter, provider);
    const hist = await request(app).get('/api/v1/payments/history')
      .set('Authorization', `Bearer ${renter.token}`);
    expect(hist.statusCode).toBe(200);
    expect(hist.body.payments.some((p) => p.id === paymentId)).toBe(true);
  });

  it('approves a pending bank-transfer payment, then rejects a second approval (400 already paid)', async () => {
    const { paymentId } = await newBankTransferPayment(renter, provider);
    const first = await request(app).post(`/api/v1/payments/manual/approve/${paymentId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(first.statusCode).toBe(200);
    expect(first.body.status).toBe('paid');

    const second = await request(app).post(`/api/v1/payments/manual/approve/${paymentId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(second.statusCode).toBe(400);
    expect(JSON.stringify(second.body)).toMatch(/already/i);
  });

  it('rejects manual approval by a non-admin (403)', async () => {
    const { paymentId } = await newBankTransferPayment(renter, provider);
    const res = await request(app).post(`/api/v1/payments/manual/approve/${paymentId}`)
      .set('Authorization', `Bearer ${renter.token}`);
    expect(res.statusCode).toBe(403);
  });

  it('404s approval of a nonexistent payment', async () => {
    const res = await request(app).post('/api/v1/payments/manual/approve/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(404);
  });

  it('refuses to manually approve a lightning payment (400)', async () => {
    // Craft a lightning payment record directly, then attempt manual approval.
    const p = PaymentRepository.create({ orderId: null, userId: renter.id, amount: 500, status: 'pending', method: 'lightning' });
    const res = await request(app).post(`/api/v1/payments/manual/approve/${p.id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/lightning/i);
  });

  it('refuses approval when the associated order is no longer payable (409)', async () => {
    const { orderId, paymentId } = await newBankTransferPayment(renter, provider);
    // Force the order into a terminal state so approval would orphan a paid record.
    OrderRepository.update(orderId, { status: 'cancelled' });
    const res = await request(app).post(`/api/v1/payments/manual/approve/${paymentId}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.statusCode).toBe(409);
  });
});
