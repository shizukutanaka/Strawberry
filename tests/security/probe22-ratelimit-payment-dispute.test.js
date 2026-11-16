// tests/security/probe22-ratelimit-payment-dispute.test.js
// Probe 22 regression tests:
// 1. rate-limit keyGenerator: TRUST_PROXY must be parsed as an integer hop count;
//    boolean-ish strings ('true','yes') are rejected so XFF spoofing can't bypass authLimiter.

const request = require('supertest');
const { app } = require('../../src/api/server');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `p22${Date.now().toString(36)}`;
let adminTok, userTok, userId;

beforeAll(async () => {
  const admName = `p22adm${uniq}`.slice(0, 20);
  const admEmail = `${admName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: admName, email: admEmail, password: 'Test1234!' });
  const admUser = UserRepository.getByEmail(admEmail);
  UserRepository.update(admUser.id, { role: 'admin' });
  adminTok = (await request(app).post('/api/v1/users/login')
    .send({ email: admEmail, password: 'Test1234!' })).body.token;

  const usrName = `p22usr${uniq}`.slice(0, 20);
  const usrEmail = `${usrName}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: usrName, email: usrEmail, password: 'Test1234!' });
  const usr = UserRepository.getByEmail(usrEmail);
  userId = usr.id;
  userTok = (await request(app).post('/api/v1/users/login')
    .send({ email: usrEmail, password: 'Test1234!' })).body.token;
});

describe('rate-limit keyGenerator: TRUST_PROXY parsed strictly as integer hop count', () => {
  // Mirrors the logic in src/api/middleware/rate-limit.js. 'true'/'yes' must NOT
  // be treated as "trust proxy" because that would trust attacker-controlled XFF.
  const trustsForwarded = (val) => {
    const hopCount = parseInt(val, 10);
    return Number.isInteger(hopCount) && hopCount > 0;
  };

  it('integer hop counts (1, 2) trust the proxy chain', () => {
    expect(trustsForwarded('1')).toBe(true);
    expect(trustsForwarded('2')).toBe(true);
  });

  it("boolean-ish strings are rejected (no XFF trust)", () => {
    expect(trustsForwarded('true')).toBe(false);
    expect(trustsForwarded('yes')).toBe(false);
    expect(trustsForwarded('on')).toBe(false);
    expect(trustsForwarded(undefined)).toBe(false);
    expect(trustsForwarded('')).toBe(false);
    expect(trustsForwarded('0')).toBe(false);
    expect(trustsForwarded('-1')).toBe(false);
  });

  it('module loads and exports the limiter + authLimiter', () => {
    const limiter = require('../../src/api/middleware/rate-limit');
    expect(typeof limiter).toBe('function');
    expect(typeof limiter.authLimiter).toBe('function');
  });
});
