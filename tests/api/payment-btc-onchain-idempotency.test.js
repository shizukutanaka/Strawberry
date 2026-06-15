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
    addProfitAddress(OPERATOR_WALLET);
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
    status: 'completed', pricePerHour: 100, totalPrice: 100,
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
});
