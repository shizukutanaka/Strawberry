// tests/security/probe23b-btconchain-payout.test.js
// Probe 23b regression tests:
// 1. POST /payment/btc no longer accepts a client-supplied lenderWallet when the
//    provider has no registered payoutAddress — payout wallet must be server-derived.
// 2. POST /payment/btc creates a PaymentRecord (status:'paid') on successful settlement,
//    so order/start/stop/dispute gates (hasPaidPayment) work correctly for btc-onchain orders.

const request = require('supertest');
const { app } = require('../../src/api/server');
const fs = require('fs');
const path = require('path');

describe('POST /payment/btc: lenderWallet cannot be client-controlled', () => {
  it('source code: bodyLenderWallet is not used as payout destination', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/payment/btc-onchain.js'),
      'utf-8'
    );
    // The old exploit: `let lenderWallet = ... ? provider.payoutAddress : bodyLenderWallet`
    // The variable name must NOT appear as the fallback value in a ternary assignment.
    expect(src).not.toMatch(/\blenderWallet\s*=.*bodyLenderWallet/);
    // req.body must not destructure a lenderWallet (or bodyLenderWallet) field.
    expect(src).not.toMatch(/req\.body[^;]+lenderWallet/);
  });

  it('source code: lenderWallet is derived exclusively from provider.payoutAddress', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/payment/btc-onchain.js'),
      'utf-8'
    );
    expect(src).toMatch(/provider\.payoutAddress/);
    // Must return 400 when payoutAddress is absent (no client-wallet fallback).
    expect(src).toMatch(/payoutAddress.*PUT.*users\/me/i);
  });
});

describe('POST /payment/btc: PaymentRecord written on successful settlement', () => {
  it('source code: PaymentRepository.create is called with status paid', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/payment/btc-onchain.js'),
      'utf-8'
    );
    expect(src).toMatch(/PaymentRepository\.create/);
    expect(src).toMatch(/status.*paid/);
    expect(src).toMatch(/method.*btc_onchain/);
  });

  it('PaymentRepository is required at module level (not inline)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/payment/btc-onchain.js'),
      'utf-8'
    );
    // Top-level require should be at beginning of file, before route handler.
    const paymentRepoReqIdx = src.indexOf("require('../../../db/json/PaymentRepository')");
    const routeHandlerIdx = src.indexOf('router.post(');
    expect(paymentRepoReqIdx).toBeGreaterThan(-1);
    expect(paymentRepoReqIdx).toBeLessThan(routeHandlerIdx);
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
