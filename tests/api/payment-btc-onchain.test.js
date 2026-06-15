// btc-onchain payout-recipient resolution (anti-spoofing) tests.
// The renter must not be able to redirect or deny the provider's payout by
// supplying an arbitrary lenderWallet. A provider-registered payoutAddress is
// authoritative; otherwise self-dealing (lenderWallet === borrowerWallet) is rejected.

// Mock the Lightning wrapper so no real network call is made and we can capture
// which destination the payout was actually sent to.
const sent = [];
jest.mock('../../src/api/utils/lightning-api', () => ({
  sendLightningPayment: jest.fn(async (dest, amountBTC) => {
    sent.push({ dest, amountBTC });
    return { id: `fake-txid-${sent.length}`, payment_hash: `hash-${sent.length}` };
  }),
}));

const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');
const { addProfitAddress } = require('../../src/api/utils/profit-addresses');

// Operator (fee) wallet must be a registered, syntactically-valid BTC address.
const OPERATOR_WALLET = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

const BORROWER_WALLET = 'bc1qborrower00000000000000000000000000';
const PROVIDER_WALLET = 'bc1qprovider00000000000000000000000000';

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 24);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  return { token: login.body.token, id: login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`)?.id };
}

describe('btc-onchain payout recipient resolution (#anti-spoof)', () => {
  let renter, provider, gpuId;

  beforeAll(async () => {
    addProfitAddress(OPERATOR_WALLET);
    renter = await registerAndLogin('btcrent');
    provider = await registerAndLogin('btcprov');
    gpuId = GpuRepository.create({
      name: 'BTC Pay GPU', vendor: 'NVIDIA', model: 'RTX-BTC', memoryGB: 16,
      pricePerHour: 100, providerId: provider.id,
    }).id;
  });

  beforeEach(() => { sent.length = 0; });

  const makeOrder = () => OrderRepository.create({
    gpuId, userId: renter.id, providerId: provider.id, durationMinutes: 60,
    status: 'completed', pricePerHour: 100, totalPrice: 100,
    createdAt: new Date().toISOString(),
  }).id;

  it('rejects self-dealing when the renter sets lenderWallet to the borrowerWallet (no registered address)', async () => {
    UserRepository.update(provider.id, { payoutAddress: '' });
    const orderId = makeOrder();
    const res = await request(app).post('/api/v1/payments/btc')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ orderId, lenderWallet: BORROWER_WALLET, borrowerWallet: BORROWER_WALLET });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/must differ from borrowerWallet/i);
    expect(sent.length).toBe(0); // no funds moved
  });

  it("uses the provider's registered payoutAddress and ignores a spoofed lenderWallet in the body", async () => {
    UserRepository.update(provider.id, { payoutAddress: PROVIDER_WALLET });
    const orderId = makeOrder();
    const attackerWallet = 'bc1qattacker0000000000000000000000000';
    const res = await request(app).post('/api/v1/payments/btc')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ orderId, lenderWallet: attackerWallet, borrowerWallet: BORROWER_WALLET });
    expect(res.statusCode).toBe(200);
    // Two sends: borrower→operator, operator→lender. The lender payout must go to
    // the registered provider address, never the attacker-supplied one.
    const payoutDest = sent[sent.length - 1].dest;
    expect(payoutDest).toBe(PROVIDER_WALLET);
    expect(sent.some(s => s.dest === attackerWallet)).toBe(false);
  });

  it('returns 400 when neither a registered payout address nor a body lenderWallet is available', async () => {
    UserRepository.update(provider.id, { payoutAddress: '' });
    const orderId = makeOrder();
    const res = await request(app).post('/api/v1/payments/btc')
      .set('Authorization', `Bearer ${renter.token}`)
      .send({ orderId, borrowerWallet: BORROWER_WALLET });
    expect(res.statusCode).toBe(400);
    expect(sent.length).toBe(0);
  });

  it('lets a provider register a payoutAddress via PUT /users/me', async () => {
    const res = await request(app).put('/api/v1/users/me')
      .set('Authorization', `Bearer ${provider.token}`)
      .send({ payoutAddress: PROVIDER_WALLET });
    expect(res.statusCode).toBe(200);
    expect(UserRepository.getById(provider.id).payoutAddress).toBe(PROVIDER_WALLET);
  });
});
