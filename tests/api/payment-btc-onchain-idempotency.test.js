// Idempotency and partial-settlement recovery tests for POST /payments/btc.
//
// Invariants under test:
//   1. A SETTLED payment is returned from cache — no Lightning calls on re-POST.
//   2. When tx2 (operator→lender) fails, escrow stays in HELD state.
//      Re-posting the same orderId skips tx1 and retries only tx2.
//   3. A retry storm after SETTLED never fires additional Lightning calls.

jest.mock('../../src/api/utils/lightning-api', () => ({
  sendLightningPayment: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../../src/api/server');
const { sendLightningPayment } = require('../../src/api/utils/lightning-api');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const EscrowRepository = require('../../src/db/json/EscrowRepository');
const { addProfitAddress } = require('../../src/api/utils/profit-addresses');

const OPERATOR_WALLET = 'bc1qoperatoridem0000000000000000000000';
const BORROWER_WALLET = 'bc1qborrowerid000000000000000000000000';
const PROVIDER_WALLET = 'bc1qproviderid000000000000000000000000';

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 24);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  const id = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`)?.id;
  return { token: login.body.token, id };
}

describe('btc-onchain payment idempotency and partial-settlement recovery', () => {
  let renter, provider, gpuId;

  beforeAll(async () => {
    await addProfitAddress(OPERATOR_WALLET);
    renter = await registerAndLogin('idemrent');
    provider = await registerAndLogin('idemprov');
    UserRepository.update(provider.id, { payoutAddress: PROVIDER_WALLET });
    gpuId = GpuRepository.create({
      name: 'Idem GPU', vendor: 'NVIDIA', model: 'RTX-ID', memoryGB: 16,
      pricePerHour: 100, providerId: provider.id,
    }).id;
  });

  beforeEach(() => {
    sendLightningPayment.mockReset();
  });

  const makeOrder = () => OrderRepository.create({
    gpuId, userId: renter.id, providerId: provider.id, durationMinutes: 60,
    // btc-onchain は pending/matched/active のみ許可（completed への二次支払いは
    // 不正資金移動になるためゲートされる — see #1 in audit batch 13）。
    status: 'pending', pricePerHour: 100, totalPrice: 100,
    createdAt: new Date().toISOString(),
  }).id;

  it('returns cached SETTLED response and makes zero Lightning calls on re-POST', async () => {
    let callCount = 0;
    sendLightningPayment.mockImplementation(async () => {
      callCount++;
      return { id: `txid-${callCount}`, payment_hash: `hash-${callCount}` };
    });

    const orderId = makeOrder();
    const body = { orderId, borrowerWallet: BORROWER_WALLET };
    const auth = { Authorization: `Bearer ${renter.token}` };

    // First POST: performs tx1 and tx2
    const r1 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(r1.statusCode).toBe(200);
    expect(callCount).toBe(2);
    const savedCount = callCount;

    // Second POST: must return cached result with zero additional Lightning calls
    const r2 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(r2.statusCode).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(callCount).toBe(savedCount);
    expect(r2.body.txBorrowerToOperator.txid).toBe(r1.body.txBorrowerToOperator.txid);
    expect(r2.body.txOperatorToLender.txid).toBe(r1.body.txOperatorToLender.txid);
  });

  it('recovers partial settlement by retrying only tx2 on re-POST', async () => {
    let callCount = 0;
    let failTx2Once = true;
    sendLightningPayment.mockImplementation(async (dest) => {
      callCount++;
      if (failTx2Once && dest === PROVIDER_WALLET) {
        failTx2Once = false;
        throw new Error('Network timeout on provider payout');
      }
      return { id: `txid-${callCount}`, payment_hash: `hash-${callCount}` };
    });

    const orderId = makeOrder();
    const body = { orderId, borrowerWallet: BORROWER_WALLET };
    const auth = { Authorization: `Bearer ${renter.token}` };

    // First attempt: tx1 OK, tx2 fails → 500 with retryable flag
    const r1 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(r1.statusCode).toBe(500);
    expect(r1.body.retryable).toBe(true);
    expect(r1.body.escrowId).toBeTruthy();
    expect(callCount).toBe(2); // tx1 + failed tx2 attempt

    // Escrow must be in HELD state with tx1 persisted
    const escrow = EscrowRepository.getById(r1.body.escrowId);
    expect(escrow.state).toBe('HELD');
    expect(escrow.txBorrowerToOperator).toBeTruthy();
    expect(escrow.txOperatorToLender).toBeUndefined();

    const callsBefore = callCount;

    // Retry with same orderId: must skip tx1 and fire only tx2
    const r2 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(r2.statusCode).toBe(200);
    expect(callCount - callsBefore).toBe(1); // only tx2 was retried

    // Escrow transitions to SETTLED
    const settled = EscrowRepository.getById(r1.body.escrowId);
    expect(settled.state).toBe('SETTLED');
    expect(settled.txOperatorToLender).toBeTruthy();

    // tx1 txid from the original attempt is preserved in the response
    expect(r2.body.txBorrowerToOperator.txid).toBe(escrow.txBorrowerToOperator);
  });

  it('does not fire tx1 again when concurrent re-POSTs hit a SETTLED escrow', async () => {
    let callCount = 0;
    sendLightningPayment.mockImplementation(async () => {
      callCount++;
      return { id: `txid-${callCount}`, payment_hash: `hash-${callCount}` };
    });

    const orderId = makeOrder();
    const body = { orderId, borrowerWallet: BORROWER_WALLET };
    const auth = { Authorization: `Bearer ${renter.token}` };

    // Settle normally
    await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(callCount).toBe(2);

    // Simulate retry storm
    const [ra, rb] = await Promise.all([
      request(app).post('/api/v1/payments/btc').set(auth).send(body),
      request(app).post('/api/v1/payments/btc').set(auth).send(body),
    ]);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(callCount).toBe(2); // no additional Lightning calls
  });

  it('refuses to create a fresh escrow when a prior canceled one carries txids (sweep-race double-charge guard)', async () => {
    // Simulates the aftermath of: tx1 broadcast → sweep cancels escrow → retry.
    // Without the guard, a new escrow would be created and tx1 re-broadcast.
    let callCount = 0;
    sendLightningPayment.mockImplementation(async () => {
      callCount++;
      return { id: `txid-${callCount}`, payment_hash: `hash-${callCount}` };
    });

    const orderId = makeOrder();
    EscrowRepository.create({
      orderId, amountSats: 150, feeRate: 0.015, state: 'CANCELED',
      txBorrowerToOperator: 'txid-already-broadcast',
    });

    const res = await request(app).post('/api/v1/payments/btc')
      .set({ Authorization: `Bearer ${renter.token}` })
      .send({ orderId, borrowerWallet: BORROWER_WALLET });

    expect(res.statusCode).toBe(409);
    expect(res.body.retryable).toBe(false);
    expect(callCount).toBe(0); // nothing broadcast
  });

  it('stops before tx2 and persists tx1 evidence when the PENDING->HELD CAS fails', async () => {
    let callCount = 0;
    sendLightningPayment.mockImplementation(async () => {
      callCount++;
      return { id: `txid-${callCount}`, payment_hash: `hash-${callCount}` };
    });

    const orderId = makeOrder();
    const body = { orderId, borrowerWallet: BORROWER_WALLET };
    const auth = { Authorization: `Bearer ${renter.token}` };

    // Fail only the first updateIf (the PENDING->HELD transition), as if a
    // concurrent sweep moved the escrow to CANCELED after tx1 broadcast.
    const realUpdateIf = EscrowRepository.updateIf;
    let failed = false;
    jest.spyOn(EscrowRepository, 'updateIf').mockImplementation((id, pred, upd) => {
      if (!failed) {
        failed = true;
        // Simulate the sweep: the row transitions to CANCELED out from under us.
        EscrowRepository.update(id, { state: 'CANCELED' });
        const cur = EscrowRepository.getById(id);
        return { ok: false, reason: 'condition_failed', current: cur };
      }
      return realUpdateIf(id, pred, upd);
    });

    const r1 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    EscrowRepository.updateIf.mockRestore();

    expect(r1.statusCode).toBe(500);
    expect(r1.body.retryable).toBe(false);
    expect(r1.body.stage).toBe('escrow_state_lost');
    expect(callCount).toBe(1); // tx1 sent, tx2 NOT sent

    // tx1 txid was persisted onto the row as evidence
    const esc = EscrowRepository.getById(r1.body.escrowId);
    expect(esc.txBorrowerToOperator).toBe('txid-1');

    // A retry now hits the orphaned-txid guard: 409, zero additional calls
    const r2 = await request(app).post('/api/v1/payments/btc').set(auth).send(body);
    expect(r2.statusCode).toBe(409);
    expect(callCount).toBe(1);
  });
});
