// POST /gpus/:id/promote — 出品プロモーション（有料 featured）の購入経路と
// paid 遷移時の gpu.featuredUntil 延長・一覧上位表示を固定する。
// Lightning 未導入のテスト環境では手動支払い経路（admin 承認で featured 化）を通る。
const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const promotions = require('../../src/utils/promotions');

async function registerAndLogin(prefix, role) {
  const u = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 20);
  const email = `${u}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email, password: 'Test1234!' });
  const id = UserRepository.getByEmail(email).id;
  if (role) UserRepository.update(id, { role });
  const res = await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' });
  return { token: res.body.token, id, email };
}

describe('POST /gpus/:id/promote', () => {
  it('rejects unauthenticated requests', async () => {
    const gpu = GpuRepository.create({ name: 'P1', vendor: 'NVIDIA', model: 'RTX-PM', memoryGB: 8, pricePerHour: 100 });
    const res = await request(app).post(`/api/v1/gpus/${gpu.id}/promote`).send({});
    expect([401, 403]).toContain(res.status);
  });

  it('forbids non-owner providers', async () => {
    const owner = await registerAndLogin('pmo', 'provider');
    const other = await registerAndLogin('pmx', 'provider');
    const gpu = GpuRepository.create({ name: 'P2', vendor: 'NVIDIA', model: 'RTX-PM2', memoryGB: 8, pricePerHour: 100, providerId: owner.id });
    const res = await request(app).post(`/api/v1/gpus/${gpu.id}/promote`)
      .set('Authorization', `Bearer ${other.token}`).send({});
    expect(res.status).toBe(403);
  });

  it('records a pending promotion payment and activates featured on admin approval', async () => {
    const provider = await registerAndLogin('pmp', 'provider');
    const admin = await registerAndLogin('pma', 'admin');
    const gpu = GpuRepository.create({ name: 'P3', vendor: 'NVIDIA', model: 'RTX-PM3', memoryGB: 8, pricePerHour: 100, providerId: provider.id });

    const res = await request(app).post(`/api/v1/gpus/${gpu.id}/promote`)
      .set('Authorization', `Bearer ${provider.token}`).send({});
    expect([201, 202]).toContain(res.status);
    const paymentId = res.body.paymentId;
    expect(paymentId).toBeTruthy();
    const rec = PaymentRepository.getById(paymentId);
    expect(rec.purpose).toBe('featured_listing');
    expect(rec.gpuId).toBe(gpu.id);
    expect(rec.status).toBe('pending');

    // 手動経路のみ承認可能（lightning 未導入環境で作成された manual 支払い）
    if (rec.method === 'manual') {
      const approve = await request(app).post(`/api/v1/payments/manual/approve/${paymentId}`)
        .set('Authorization', `Bearer ${admin.token}`).send({});
      expect(approve.status).toBe(200);
      const featured = GpuRepository.getById(gpu.id);
      expect(featured.featuredUntil).toBeTruthy();
      expect(new Date(featured.featuredUntil).getTime()).toBeGreaterThan(Date.now());
      expect(promotions.isFeatured(featured)).toBe(true);
    }
  });

  it('is idempotent while a pending promotion payment exists', async () => {
    const provider = await registerAndLogin('pmi', 'provider');
    const gpu = GpuRepository.create({ name: 'P4', vendor: 'NVIDIA', model: 'RTX-PM4', memoryGB: 8, pricePerHour: 100, providerId: provider.id });
    const first = await request(app).post(`/api/v1/gpus/${gpu.id}/promote`)
      .set('Authorization', `Bearer ${provider.token}`).send({});
    const second = await request(app).post(`/api/v1/gpus/${gpu.id}/promote`)
      .set('Authorization', `Bearer ${provider.token}`).send({});
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.paymentId).toBe(first.body.paymentId);
  });

  it('ranks featured listings first in GET /gpus', async () => {
    const cheap = GpuRepository.create({ name: 'Cheap', vendor: 'NVIDIA', model: 'RTX-C', memoryGB: 8, pricePerHour: 50 });
    GpuRepository.create({
      name: 'Expensive Featured', vendor: 'NVIDIA', model: 'RTX-EF', memoryGB: 8,
      pricePerHour: 9999, featuredUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const res = await request(app).get('/api/v1/gpus?sort=price');
    expect(res.status).toBe(200);
    const ids = res.body.gpus.map((g) => g.id);
    expect(ids[0]).not.toBe(cheap.id);
    const first = res.body.gpus[0];
    expect(first.featured).toBe(true);
    expect(first.pricePerHour).toBe(9999);
  });
});

describe('promotions utils', () => {
  it('isFeatured treats expired/missing featuredUntil as not featured', () => {
    expect(promotions.isFeatured({ featuredUntil: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(promotions.isFeatured({})).toBe(false);
    expect(promotions.isFeatured({ featuredUntil: new Date(Date.now() + 1000).toISOString() })).toBe(true);
  });

  it('onPaymentPaid extends from current featuredUntil when still active', () => {
    const gpu = GpuRepository.create({
      name: 'Ext', vendor: 'NVIDIA', model: 'RTX-EXT', memoryGB: 8, pricePerHour: 10,
      featuredUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const before = new Date(gpu.featuredUntil).getTime();
    const payment = PaymentRepository.create({ purpose: 'featured_listing', gpuId: gpu.id, userId: 'u-x', amount: 1, status: 'paid', method: 'manual' });
    const updated = promotions.onPaymentPaid(payment);
    expect(updated).toBeTruthy();
    expect(new Date(updated.featuredUntil).getTime()).toBeGreaterThan(before);
  });

  it('onPaymentPaid ignores non-promotion payments', () => {
    const gpu = GpuRepository.create({ name: 'Nop', vendor: 'NVIDIA', model: 'RTX-N', memoryGB: 8, pricePerHour: 10 });
    const payment = PaymentRepository.create({ orderId: 'o-x', userId: 'u-x', amount: 1, status: 'paid', method: 'manual' });
    expect(promotions.onPaymentPaid(payment)).toBeNull();
    expect(GpuRepository.getById(gpu.id).featuredUntil).toBeUndefined();
  });
});

describe('promotions hardening (Devin Review flags)', () => {
  it('promotionConfig rejects fractional values by falling back to defaults', () => {
    const d = process.env.FEATURED_LISTING_DAYS;
    const p = process.env.FEATURED_LISTING_PRICE_SATS;
    process.env.FEATURED_LISTING_DAYS = '0.5';
    process.env.FEATURED_LISTING_PRICE_SATS = '0.5';
    const cfg = promotions.promotionConfig();
    expect(cfg.days).toBe(7);
    expect(cfg.priceSats).toBe(1000);
    if (d === undefined) delete process.env.FEATURED_LISTING_DAYS; else process.env.FEATURED_LISTING_DAYS = d;
    if (p === undefined) delete process.env.FEATURED_LISTING_PRICE_SATS; else process.env.FEATURED_LISTING_PRICE_SATS = p;
  });

  it('failStalePromotions terminally fails expired pending promotions', () => {
    const gpu = GpuRepository.create({ name: 'Stale', vendor: 'NVIDIA', model: 'RTX-S', memoryGB: 8, pricePerHour: 10 });
    const stale = PaymentRepository.create({
      purpose: 'featured_listing', gpuId: gpu.id, userId: 'u-s', amount: 1000,
      status: 'pending', method: 'lightning', paymentHash: 'h1',
      invoiceExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(promotions.failStalePromotions(gpu.id)).toBe(1);
    const after = PaymentRepository.getById(stale.id);
    expect(after.status).toBe('failed');
    expect(after.failReason).toBe('replaced');
  });

  it('onPaymentPaid is idempotent via featuredActivatedAt and anchors at paidAt', () => {
    const gpu = GpuRepository.create({ name: 'Idem', vendor: 'NVIDIA', model: 'RTX-I', memoryGB: 8, pricePerHour: 10 });
    const paidAt = new Date(Date.now() - 3 * 86_400_000).toISOString(); // 3日前に支払い
    const payment = PaymentRepository.create({
      purpose: 'featured_listing', gpuId: gpu.id, userId: 'u-i', amount: 1000,
      status: 'paid', paidAt, method: 'manual',
    });
    const g1 = promotions.onPaymentPaid(payment);
    expect(g1).toBeTruthy();
    const until1 = new Date(g1.featuredUntil).getTime();
    // paidAt 起点 + 7日 — 支払い時刻からの満額（適用遅れで縮まない）
    expect(until1).toBeGreaterThan(new Date(paidAt).getTime() + 6 * 86_400_000);
    expect(PaymentRepository.getById(payment.id).featuredActivatedAt).toBeTruthy();
    // 二度目の呼び出しは no-op（延長しない）
    expect(promotions.onPaymentPaid(payment)).toBeNull();
    expect(GpuRepository.getById(gpu.id).featuredUntil).toBe(g1.featuredUntil);
  });

  it('reconcilePaidPromotions recovers paid-but-unapplied payments', () => {
    const gpu = GpuRepository.create({ name: 'Recon', vendor: 'NVIDIA', model: 'RTX-R', memoryGB: 8, pricePerHour: 10 });
    const payment = PaymentRepository.create({
      purpose: 'featured_listing', gpuId: gpu.id, userId: 'u-r', amount: 1000,
      status: 'paid', paidAt: new Date().toISOString(), method: 'manual',
    });
    expect(GpuRepository.getById(gpu.id).featuredUntil).toBeUndefined();
    expect(promotions.reconcilePaidPromotions()).toBe(0); // 回収成功 → 残 0
    expect(GpuRepository.getById(gpu.id).featuredUntil).toBeTruthy();
    expect(PaymentRepository.getById(payment.id).featuredActivatedAt).toBeTruthy();
  });

  it('reconcile returns remaining count for unrecoverable payments (missing gpu)', () => {
    const stray = PaymentRepository.create({
      purpose: 'featured_listing', gpuId: 'gpu-nonexistent', userId: 'u-x', amount: 1000,
      status: 'paid', paidAt: new Date().toISOString(), method: 'manual',
    });
    try {
      expect(promotions.reconcilePaidPromotions()).toBeGreaterThanOrEqual(1);
    } finally {
      PaymentRepository.delete(stray.id);
    }
  });
});
