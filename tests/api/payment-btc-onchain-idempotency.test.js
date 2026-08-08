// POST /payments/btc is fail-closed: it must never move funds.
//
// History: this route used to run two transfers — "tx1: borrower→operator" then
// "tx2: operator→lender" — with idempotent resume between them, and this file
// tested that resume logic. But sendBTC(from, to, amount) ignores `from` and
// calls sendLightningPayment(to, amount), whose backends are send-only (OpenNode
// POST /v2/withdrawals, LNbits {out:true}). So tx1 never debited the renter: it
// paid the platform's own operator wallet out of platform funds, and tx2 then
// paid the provider. The platform paid twice and collected nothing — and any
// renter could trigger it on their own order.
//
// On Lightning there is no true "pull" payment: LNURL-withdraw acts on a
// withdraw permission the funding side issued in advance, and BOLT12's
// invoice_request likewise needs the initiating side to act. A server cannot
// debit a renter's wallet from an API call. Collection is therefore only
// possible as "the renter pays an invoice", which the Lightning flow
// (POST /payments/order/:id + invoice-poller) already does correctly. The
// transfers here were removed rather than "fixed".
//
// Invariants now under test:
//   1. Once the guards pass, the route returns 501, fires zero Lightning calls,
//      and leaves no escrow record behind.
//   2. Repeated posts accrue no state.
//   3. A SETTLED escrow written before this change still returns its cached
//      result without any Lightning call.

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

describe('btc-onchain payment is fail-closed (moves no funds)', () => {
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
    // Any call at all is a regression, so make one fail loudly if it happens.
    sendLightningPayment.mockImplementation(async () => {
      throw new Error('sendLightningPayment must never be called by this route');
    });
  });

  const makeOrder = () => OrderRepository.create({
    gpuId, userId: renter.id, providerId: provider.id, durationMinutes: 60,
    status: 'pending', pricePerHour: 100, totalPrice: 100,
    createdAt: new Date().toISOString(),
  }).id;

  it('returns 501, moves no funds, and creates no escrow', async () => {
    const orderId = makeOrder();
    const res = await request(app).post('/api/v1/payments/btc')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ orderId, borrowerWallet: BORROWER_WALLET });

    expect(res.statusCode).toBe(501);
    expect(res.body.code).toBe('BTC_ONCHAIN_NOT_IMPLEMENTED');
    expect(res.body.useInstead).toBe('POST /api/v1/payments/order/:id');
    expect(sendLightningPayment).not.toHaveBeenCalled();
    // No PENDING escrow may be left behind polluting the data layer.
    expect(EscrowRepository.getByOrderId(orderId)).toHaveLength(0);
  });

  it('stays fail-closed across concurrent reposts, accruing no state', async () => {
    const orderId = makeOrder();
    const body = { orderId, borrowerWallet: BORROWER_WALLET };
    const auth = { Authorization: `Bearer ${renter.token}` };

    const [r1, r2, r3] = await Promise.all([
      request(app).post('/api/v1/payments/btc').set(auth).send(body),
      request(app).post('/api/v1/payments/btc').set(auth).send(body),
      request(app).post('/api/v1/payments/btc').set(auth).send(body),
    ]);
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([501, 501, 501]);
    expect(sendLightningPayment).not.toHaveBeenCalled();
    expect(EscrowRepository.getByOrderId(orderId)).toHaveLength(0);
  });

  it('still returns a legacy SETTLED escrow from cache without any Lightning call', async () => {
    // Data written before the fail-closed change: the cached-result path is kept
    // because it moves no funds and preserves the old idempotency contract.
    const orderId = makeOrder();
    EscrowRepository.create({
      orderId,
      amountSats: 101,
      state: 'SETTLED',
      total: 0.00000101,
      payout: 0.000001,
      fee: 0.00000001,
      txBorrowerToOperator: 'legacy-tx1',
      txOperatorToLender: 'legacy-tx2',
      lenderWallet: PROVIDER_WALLET,
      operatorWallet: OPERATOR_WALLET,
    });

    const res = await request(app).post('/api/v1/payments/btc')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ orderId, borrowerWallet: BORROWER_WALLET });

    expect(res.statusCode).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.txBorrowerToOperator.txid).toBe('legacy-tx1');
    expect(res.body.txOperatorToLender.txid).toBe('legacy-tx2');
    expect(sendLightningPayment).not.toHaveBeenCalled();
  });
});
