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

// This block previously asserted the opposite — that the route writes a paid
// PaymentRecord "on successful settlement". That invariant is gone because the
// settlement itself was removed: the route's premise (tx1 "borrower→operator")
// is impossible. sendBTC ignores its fromWallet and calls sendLightningPayment,
// which is send-only (OpenNode /v2/withdrawals, LNbits {out:true}), so tx1 paid
// the platform's own wallet out of platform funds and tx2 then paid the
// provider: two payments out, nothing collected, triggerable by any renter on
// their own order. The route is fail-closed now, and these are the inverted
// guards that keep it that way.
describe('POST /payment/btc: fail-closed — must never move funds', () => {
  const readSrc = () => fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/payment/btc-onchain.js'),
    'utf-8'
  );
  // "Is it called?" assertions must look at executable code only: the file
  // deliberately *documents* the removed leak in its comments, and a whole-file
  // grep would match that prose and fail.
  const readCode = () => readSrc()
    .replace(/\/\*[\s\S]*?\*\//g, '')    // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (without eating "https://")

  it('source code: no fund-transfer helper is imported or called', () => {
    const code = readCode();
    // sendBTC must not be imported — keeping it out of scope makes an accidental
    // re-wiring of the payout a syntax error rather than a silent money leak.
    expect(code).not.toMatch(/\bsendBTC\b[^}]*\}\s*=\s*require/);
    expect(code).not.toMatch(/\bsendBTC\s*\(/);
  });

  it('source code: no paid PaymentRecord is written (nothing was actually paid)', () => {
    expect(readCode()).not.toMatch(/PaymentRepository\.create/);
  });

  it('source code: the handler fails closed with 501 and points at the Lightning flow', () => {
    const code = readCode();
    expect(code).toMatch(/status\(501\)/);
    expect(code).toMatch(/BTC_ONCHAIN_NOT_IMPLEMENTED/);
    expect(code).toMatch(/payments\/order/);
  });

  it('PaymentRepository is still required at module level for the cross-method paid check', () => {
    // Reading existing payments (to reject an order already paid via Lightning)
    // is still needed; only the *writing* of a paid record was removed.
    const src = readSrc();
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
