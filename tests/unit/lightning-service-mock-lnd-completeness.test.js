// tests/unit/lightning-service-mock-lnd-completeness.test.js
//
// Regression for the next link in the mock-LND bug chain (see
// lightning-service-node-info-channels.test.js for the previous two).
//
// Confirmed live against a running `PORT=3999 node src/api/server.js` with no
// LND configured (so setupMockLND() is used):
//
//   error: Failed to subscribe to channel stream
//          this.lnd.subscribeChannelEvents is not a function
//
// ...emitted every 5 seconds, forever. setupChannelStream() in
// setupEventStreams() catches the TypeError and schedules itself again via
// setTimeout(..., 5000), so a server started without LND spins a permanent
// error loop that also writes an audit-log entry per iteration.
//
// Root cause: setupMockLND() only implemented 7 of the RPCs the service
// actually calls. Every remaining `this.lnd.X(...)` was `undefined` and threw
// on the mock path:
//
//   subscribeChannelEvents  -> permanent 5s error/reconnect loop (above)
//   channelBalance          -> getChannelBalance() always hit its catch and
//                              returned hard-coded fallback numbers that
//                              disagree with the mock's listChannels()
//   pendingChannels         -> getChannelStats() logged a failure every call
//   settleInvoice           -> settleHoldInvoice() always threw
//   cancelInvoice           -> cancelHoldInvoice() always failed
//   openChannelSync         -> openChannel() always threw
//   closeChannel            -> closeChannel() threw synchronously
//
// Fix: implement all of them on the mock with the real gRPC calling
// conventions — (request, callback) for unary RPCs, a returned stream for
// streaming ones.
//
// These tests assert the *contract* the service code depends on, so they fail
// if any of these stubs is removed again.

const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

// Every RPC name reachable as `this.lnd.<name>` anywhere in lightning-service.js.
const REQUIRED_UNARY_RPCS = [
  'getInfo',
  'addInvoice',
  'lookupInvoice',
  'sendPaymentSync',
  'decodePayReq',
  'listChannels',
  'channelBalance',
  'pendingChannels',
  'settleInvoice',
  'cancelInvoice',
  'openChannelSync',
];
const REQUIRED_STREAM_RPCS = ['subscribeInvoices', 'subscribeChannelEvents', 'closeChannel'];

describe('mock LND implements every RPC the service calls', () => {
  it.each([...REQUIRED_UNARY_RPCS, ...REQUIRED_STREAM_RPCS])(
    'this.lnd.%s is a function',
    (name) => {
      const svc = makeMockService();
      expect(typeof svc.lnd[name]).toBe('function');
    }
  );

  it('no `this.lnd.X` call site in the source lacks a mock implementation', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../lightning-service.js'),
      'utf-8'
    );
    const called = new Set();
    // Only count real call sites: `this.lnd.name(` followed by an open paren.
    // (A bare `this.lnd.X` in a prose comment must not be treated as an RPC.)
    const re = /this\.lnd\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) called.add(m[1]);

    // Sanity: the scanner must actually find the known RPCs, otherwise an
    // over-strict regex would make this test vacuously pass.
    expect(called.has('subscribeChannelEvents')).toBe(true);
    expect(called.size).toBeGreaterThanOrEqual(10);

    const svc = makeMockService();
    const missing = [...called].filter((n) => typeof svc.lnd[n] !== 'function');
    expect(missing).toEqual([]);
  });
});

describe('subscribeChannelEvents: the permanent reconnect loop is gone', () => {
  it('returns an event-emitter-like stream instead of throwing', () => {
    const svc = makeMockService();
    let stream;
    expect(() => {
      stream = svc.lnd.subscribeChannelEvents({});
    }).not.toThrow();
    expect(typeof stream.on).toBe('function');
  });

  it('does not emit end/close (which would re-trigger the 5s reconnect loop)', async () => {
    const svc = makeMockService();
    const stream = svc.lnd.subscribeChannelEvents({});
    const seen = [];
    stream.on('end', () => seen.push('end'));
    stream.on('close', () => seen.push('close'));
    stream.on('error', () => seen.push('error'));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });
});

describe('channelBalance: getChannelBalance() no longer falls through to its catch', () => {
  it('returns numbers consistent with the mock listChannels() balances', async () => {
    const svc = makeMockService();
    const bal = await svc.getChannelBalance();
    // The mock has a single channel with local_balance 5_000_000.
    // The old catch-path fallback returned balance: 1_000_000 — a value that
    // matches no channel and was the tell that the RPC was missing.
    expect(bal.balance).toBe(5000000);
    expect(bal.localBalance.sat).toBe(5000000);
    expect(bal.remoteBalance.sat).toBe(5000000);
    expect(bal.pendingOpenBalance).toBe(0);
  });
});

describe('pendingChannels: getChannelStats() resolves the pending figure', () => {
  it('reports pending as 0 (parsed from the RPC, not swallowed by the catch)', async () => {
    const svc = makeMockService();
    await svc.updateChannels();
    const stats = await svc.getChannelStats();
    expect(stats.pending).toBe('0');
    expect(stats.active).toBeGreaterThan(0);
  });
});

describe('hold-invoice and channel RPCs no longer throw on the mock path', () => {
  it('settleHoldInvoice() resolves', async () => {
    const svc = makeMockService();
    await expect(svc.settleHoldInvoice(require('crypto').randomBytes(32))).resolves.toBeUndefined();
  });

  it('cancelHoldInvoice() resolves', async () => {
    const svc = makeMockService();
    await expect(svc.cancelHoldInvoice('deadbeef')).resolves.toBeUndefined();
  });

  it('openChannel() resolves with a funding txid', async () => {
    const svc = makeMockService();
    const res = await svc.openChannel('a'.repeat(66), 100000);
    expect(typeof res.fundingTxid).toBe('string');
    expect(res.fundingTxid.length).toBeGreaterThan(0);
    expect(res.outputIndex).toBe(0);
  });
});
