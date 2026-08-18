// tests/api/payouts.test.js
// 収益台帳 API のエンド・ツー・エンド。ここが通らないと「プロバイダは自分の稼ぎを
// 一切見られず、受け取る手段も無い」という以前の状態に戻る。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const LedgerRepository = require('../../src/db/json/LedgerRepository');

const uniq = Date.now().toString(36);
let adminTok, provTok, renterTok, provId, renterId;

async function registerUser(prefix) {
  const name = `${prefix}${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const user = UserRepository.getByEmail(email);
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: user.id, token, email };
}

beforeAll(async () => {
  const adm = await registerUser('payadm');
  UserRepository.update(adm.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: adm.email, password: 'Test1234!' })).body.token;

  const prov = await registerUser('payprv');
  provId = prov.id; provTok = prov.token;
  UserRepository.update(provId, { payoutAddress: 'lnbc-provider-destination' });

  const renter = await registerUser('payrnt');
  renterId = renter.id; renterTok = renter.token;
});

const asAdmin = (r) => r.set('Authorization', `Bearer ${adminTok}`);
const asProvider = (r) => r.set('Authorization', `Bearer ${provTok}`);
const asRenter = (r) => r.set('Authorization', `Bearer ${renterTok}`);

/** 完了済み・支払い済みの注文を 1 件作る（掃き出しの入力）。 */
function seedPaidCompletedOrder(totalPrice = 100000, overrides = {}) {
  const gpu = GpuRepository.create({
    name: 'Payout Test GPU', vendor: 'NVIDIA', model: 'RTX-PAY', memoryGB: 8,
    pricePerHour: totalPrice, providerId: provId,
  });
  const order = OrderRepository.create({
    gpuId: gpu.id, userId: renterId, providerId: provId,
    durationMinutes: 60, status: 'completed', totalPrice,
    completedAt: new Date().toISOString(),
    ...overrides,
  });
  PaymentRepository.create({
    orderId: order.id, userId: renterId, amount: totalPrice,
    status: 'paid', method: 'lightning', paidAt: new Date().toISOString(),
  });
  return order;
}

describe('GET /payments/earnings', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/payments/earnings');
    expect(res.status).toBe(401);
  });

  it('starts at a zero balance and reports the minimum payout', async () => {
    const res = await asRenter(request(app).get('/api/v1/payments/earnings'));
    expect(res.status).toBe(200);
    expect(res.body.balance).toMatchObject({ availableSats: expect.any(Number) });
    expect(res.body.minimumPayoutSats).toBeGreaterThan(0);
  });
});

describe('earnings sweep → provider balance', () => {
  let order;

  it('credits the provider after the sweep runs', async () => {
    const before = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance.availableSats;
    order = seedPaidCompletedOrder(100000);

    const sweep = await asAdmin(request(app).post('/api/v1/payments/admin/earnings/sweep'));
    expect(sweep.status).toBe(200);
    expect(sweep.body.credited).toBeGreaterThanOrEqual(1);

    const after = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance.availableSats;
    // 実提供 100%・手数料控除後なので、増分は 0 より大きく総額未満。
    expect(after - before).toBeGreaterThan(0);
    expect(after - before).toBeLessThan(100000);

    const entries = LedgerRepository.getByOrderId(order.id);
    expect(entries.some((e) => e.kind === 'earning' && e.userId === provId)).toBe(true);
  });

  it('does not credit the same order twice when the sweep runs again', async () => {
    const before = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance.availableSats;
    await asAdmin(request(app).post('/api/v1/payments/admin/earnings/sweep'));
    const after = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance.availableSats;
    expect(after).toBe(before);
    expect(LedgerRepository.getByOrderId(order.id).filter((e) => e.kind === 'earning')).toHaveLength(1);
  });

  it('shows the earning entry in the provider ledger', async () => {
    const res = await asProvider(request(app).get('/api/v1/payments/earnings?limit=200'));
    const mine = res.body.entries.filter((e) => e.orderId === order.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'earning', role: 'provider', status: 'settled' });
    expect(mine[0].breakdown.operatorFeeSats).toBeGreaterThan(0);
  });

  it('refuses the admin sweep for a non-admin', async () => {
    const res = await asProvider(request(app).post('/api/v1/payments/admin/earnings/sweep'));
    expect(res.status).toBe(403);
  });
});

describe('POST /payments/payouts', () => {
  it('rejects a payout larger than the balance', async () => {
    const res = await asProvider(request(app).post('/api/v1/payments/payouts').send({ amountSats: 99999999 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('insufficient_balance');
  });

  it('rejects a payout when the user has no payout address registered', async () => {
    const res = await asRenter(request(app).post('/api/v1/payments/payouts').send({ amountSats: 5000 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_payout_address');
  });

  it('ignores a destination supplied in the request body', async () => {
    // 送金先を body から取ると、トークンを盗んだ攻撃者が宛先だけ差し替えて資金を抜ける。
    const res = await asProvider(request(app).post('/api/v1/payments/payouts')
      .send({ amountSats: 2000, destination: 'lnbc-attacker-address', payoutAddress: 'lnbc-attacker-address' }));
    expect(res.status).toBe(201);
    expect(res.body.payout.destination).toBe('lnbc-provider-destination');
  });

  it('reserves the requested sats so they cannot be requested again', async () => {
    const balance = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance;
    expect(balance.reservedSats).toBeGreaterThan(0);
    const res = await asProvider(request(app).post('/api/v1/payments/payouts')
      .send({ amountSats: balance.availableSats + 1 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('insufficient_balance');
  });
});

describe('admin payout settlement', () => {
  let payoutId;

  it('lists the pending payout for the operator', async () => {
    const res = await asAdmin(request(app).get('/api/v1/payments/admin/payouts'));
    expect(res.status).toBe(200);
    const mine = res.body.payouts.filter((p) => p.userId === provId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    payoutId = mine[0].id;
    expect(mine[0].destination).toBe('lnbc-provider-destination');
  });

  it('refuses to mark a payout sent without a transaction id', async () => {
    const res = await asAdmin(request(app).post(`/api/v1/payments/admin/payouts/${payoutId}/complete`).send({}));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('txid_required');
  });

  it('refuses a non-admin trying to settle a payout', async () => {
    const res = await asProvider(request(app).post(`/api/v1/payments/admin/payouts/${payoutId}/complete`)
      .send({ txid: 'deadbeef' }));
    expect(res.status).toBe(403);
  });

  it('records the transaction id and moves the payout out of reserved', async () => {
    const before = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance;
    const res = await asAdmin(request(app).post(`/api/v1/payments/admin/payouts/${payoutId}/complete`)
      .send({ txid: 'txid-abcdef123456' }));
    expect(res.status).toBe(200);
    expect(res.body.payout).toMatchObject({ status: 'paid', txid: 'txid-abcdef123456' });

    const after = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance;
    expect(after.reservedSats).toBe(before.reservedSats - res.body.payout.amountSats);
    expect(after.paidOutSats).toBe(before.paidOutSats + res.body.payout.amountSats);
    expect(after.availableSats).toBe(before.availableSats);
  });

  it('cannot settle the same payout twice', async () => {
    const res = await asAdmin(request(app).post(`/api/v1/payments/admin/payouts/${payoutId}/complete`)
      .send({ txid: 'txid-second-attempt' }));
    expect(res.status).toBe(400);
  });
});

describe('rejecting a payout returns the funds', () => {
  it('restores the available balance', async () => {
    const balance = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance;
    const amount = Math.min(2000, balance.availableSats);
    const req1 = await asProvider(request(app).post('/api/v1/payments/payouts').send({ amountSats: amount }));
    expect(req1.status).toBe(201);
    const id = req1.body.payout.id;

    const rejected = await asAdmin(request(app).post(`/api/v1/payments/admin/payouts/${id}/reject`)
      .send({ reason: 'destination unreachable' }));
    expect(rejected.status).toBe(200);
    expect(rejected.body.payout.status).toBe('rejected');

    const after = (await asProvider(request(app).get('/api/v1/payments/earnings'))).body.balance;
    expect(after.availableSats).toBe(balance.availableSats);
  });
});

describe('a dispute resolved for the renter actually refunds them', () => {
  // 実サーバで見つけた最悪のバグの統合レベル回帰テスト。
  // 借り手が払い、稼働し、係争を起こして勝っても、台帳が 'completed' しか
  // 見ていなかったため 1 sat も返らず、運営が全額持ったままだった。
  let order;

  it('runs the full pay → dispute → refund ruling → sweep chain', async () => {
    const gpu = GpuRepository.create({
      name: 'Dispute Refund GPU', vendor: 'NVIDIA', model: 'RTX-DISP', memoryGB: 8,
      pricePerHour: 60000, providerId: provId,
    });
    order = OrderRepository.create({
      gpuId: gpu.id, userId: renterId, providerId: provId,
      durationMinutes: 60, status: 'disputed', totalPrice: 60000,
      dispute: { raisedBy: renterId, reason: 'never reachable', raisedAt: new Date().toISOString() },
    });
    PaymentRepository.create({
      orderId: order.id, userId: renterId, amount: 60000,
      status: 'paid', method: 'lightning', paidAt: new Date().toISOString(),
    });

    const resolved = await asAdmin(request(app).post(`/api/v1/orders/${order.id}/dispute/resolve`)
      .send({ decision: 'refund', note: 'provider never delivered access' }));
    expect(resolved.status).toBe(200);
    expect(OrderRepository.getById(order.id)).toMatchObject({
      status: 'cancelled', cancelReason: 'dispute_resolved_refund',
    });

    await asAdmin(request(app).post('/api/v1/payments/admin/earnings/sweep'));
  });

  it('credits the renter the full amount they paid', () => {
    const entries = LedgerRepository.getByOrderId(order.id);
    const refund = entries.find((e) => e.kind === 'refund');
    expect(refund).toBeDefined();
    expect(refund.userId).toBe(renterId);
    expect(refund.amountSats).toBe(60000);
  });

  it('pays the provider nothing for a dispute they lost', () => {
    const entries = LedgerRepository.getByOrderId(order.id);
    expect(entries.filter((e) => e.kind === 'earning')).toHaveLength(0);
  });

  it('takes no operator fee and no minimum charge', () => {
    const refund = LedgerRepository.getByOrderId(order.id).find((e) => e.kind === 'refund');
    expect(refund.breakdown.totalSats).toBe(60000);
    expect(refund.breakdown.deliveredRatio).toBe(0);
  });

  it('makes the refund visible on the renter ledger endpoint', async () => {
    const res = await asRenter(request(app).get('/api/v1/payments/earnings?limit=200'));
    expect(res.status).toBe(200);
    expect(res.body.entries.some((e) => e.orderId === order.id && e.kind === 'refund')).toBe(true);
  });
});

describe('GET /payments/admin/reconciliation', () => {
  it('is admin-only', async () => {
    expect((await asProvider(request(app).get('/api/v1/payments/admin/reconciliation'))).status).toBe(403);
    expect((await request(app).get('/api/v1/payments/admin/reconciliation')).status).toBe(401);
  });

  it('reports the books as balanced after the sweep has run', async () => {
    await asAdmin(request(app).post('/api/v1/payments/admin/earnings/sweep'));
    const res = await asAdmin(request(app).get('/api/v1/payments/admin/reconciliation'));
    expect(res.status).toBe(200);

    // 保存則と「出所のない計上」は、他スイートが新しい注文を作っても壊れない
    // （既に計上済みの注文だけを見る検査なので）。
    expect(res.body.discrepancies).toEqual([]);
    expect(res.body.invariants.conservationHolds).toBe(true);
    expect(res.body.invariants.noOrphanCredits).toBe(true);

    // noUncreditedTerminalOrders は**データセット全体**に対する検査なので、
    // ここで true を要求してはいけない。jest は 145 スイートを並列で走らせ、
    // 全スイートが同じ data/*.json を共有する。掃き出しと突き合わせの間に
    // 他スイートが「支払い済み・完了」の注文を作れば、それは正しく
    // 未計上として報告される（次の掃き出しで計上される）。検査は正しく、
    // グローバルな真偽をこの位置で主張することが誤り。
    // 代わりに**このスイートが作った注文**が未計上でないことを見る。
    const mine = new Set(LedgerRepository.getAll()
      .filter((e) => e.userId === provId || e.userId === renterId)
      .map((e) => e.orderId));
    const mineUncredited = res.body.uncreditedTerminal.filter((u) => mine.has(u.orderId));
    expect(mineUncredited).toEqual([]);
  });

  it('reports what the operator is still holding on behalf of others', async () => {
    const res = await asAdmin(request(app).get('/api/v1/payments/admin/reconciliation'));
    const t = res.body.totals;
    expect(t.outstandingLiabilitySats)
      .toBe(t.providerEarnedSats + t.renterRefundedSats - t.payoutPaidSats);
    expect(t.renterPaidSats).toBeGreaterThan(0);
  });
});

describe('an unpaid order never credits anyone', () => {
  it('leaves the ledger untouched', async () => {
    const gpu = GpuRepository.create({
      name: 'Unpaid GPU', vendor: 'NVIDIA', model: 'RTX-UNPAID', memoryGB: 8,
      pricePerHour: 1000, providerId: provId,
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId: renterId, providerId: provId,
      durationMinutes: 60, status: 'completed', totalPrice: 50000,
    });
    // 支払いレコードは pending のみ（＝借り手はまだ払っていない）
    PaymentRepository.create({
      orderId: order.id, userId: renterId, amount: 50000, status: 'pending', method: 'lightning',
    });
    await asAdmin(request(app).post('/api/v1/payments/admin/earnings/sweep'));
    expect(LedgerRepository.getByOrderId(order.id)).toHaveLength(0);
  });
});
