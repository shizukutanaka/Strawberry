// Regression: POST /peerid/link must reject a peerId that is already claimed by
// a different user. Without the uniqueness check any authenticated user can
// overwrite another user's peerId — breaking P2P routing and enabling
// impersonation on the libp2p layer.
const request = require('supertest');
const { app } = require('../../src/api/server');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 22);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  return { token: login.body.token };
}

const PEER_ID = 'QmTestPeer1234567890ABCDEFabcdef1234567890abcdef';

describe('POST /peerid/link uniqueness', () => {
  let tokenA, tokenB;

  beforeAll(async () => {
    ({ token: tokenA } = await registerAndLogin('prid'));
    ({ token: tokenB } = await registerAndLogin('prid'));
  });

  it('allows the first user to claim a peerId', async () => {
    const res = await request(app).post('/api/v1/users/peerid/link')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ peerId: PEER_ID });
    expect(res.statusCode).toBe(200);
    expect(res.body.peerId).toBe(PEER_ID);
  });

  it('rejects a second user trying to claim the same peerId (409)', async () => {
    const res = await request(app).post('/api/v1/users/peerid/link')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ peerId: PEER_ID });
    expect(res.statusCode).toBe(409);
  });

  it('allows the original owner to re-link the same peerId (idempotent)', async () => {
    const res = await request(app).post('/api/v1/users/peerid/link')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ peerId: PEER_ID });
    expect(res.statusCode).toBe(200);
  });

  it('allows the second user to link a different peerId', async () => {
    const res = await request(app).post('/api/v1/users/peerid/link')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ peerId: 'QmOtherPeer9876543210ZYXWVUTSRQPONMLKJIHGFEDCBA' });
    expect(res.statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/users/peerid/link')
      .send({ peerId: PEER_ID });
    expect(res.statusCode).toBe(401);
  });
});
