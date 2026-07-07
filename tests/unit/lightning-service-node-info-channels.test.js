// tests/unit/lightning-service-node-info-channels.test.js
//
// Regression for a set of bugs found by continuing the live smoke-test of the
// running server after fixing checkInvoice (see the create-invoice and
// check-invoice test files in this same directory for the earlier two bugs in
// this chain). Confirmed live against a running `node src/api/server.js`:
//
//   GET /api/v1/node-info           -> 500 "Failed to get node info"
//   GET /api/v1/payments/node-info  -> 500 "lightning.getNodeInfo is not a function"
//   GET /api/v1/payments/channels   -> 500 "lightning.listChannels is not a function"
//
// Two stacked defects:
//
// 1. Missing public methods: routes call `lightning.getNodeInfo()` and
//    `lightning.listChannels()`, but LightningService only had differently
//    named internal methods (`updateNodeInfo()`, which stores into
//    `this.nodeInfo` but returns nothing, and `updateChannels()`, which stores
//    into the `this.channels` Map but returns nothing). Neither `getNodeInfo`
//    nor `listChannels` existed as callable methods at all.
//
// 2. Mock LND calling-convention mismatch (same pattern as the createInvoice
//    bug): the internal getInfo()/updateChannels() methods call
//    `this.lnd.getInfo({}, callback)` / `this.lnd.listChannels({}, callback)`
//    — the real gRPC calling convention, two arguments. But the mock's
//    getInfo/listChannels stubs only declared `(callback)`, a single
//    parameter — so the caller's empty-object first argument got bound to
//    that parameter, the real callback was silently dropped, and the mock's
//    internal `callback(null, {...})` call threw
//    "TypeError: callback is not a function" (the object `{}` is not callable).
//    This ALSO broke the service-monitor's auto-restart of LightningService,
//    since restart calls initialize() -> updateNodeInfo() -> getInfo().
//
// Fix: added getNodeInfo()/listChannels() as public methods wrapping the
// internal update*() methods, and fixed the mock's getInfo/listChannels to
// accept (request, callback) matching every real caller.

const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('LightningService.getNodeInfo(): public method exists and works via the mock', () => {
  it('is a function on the service (the core bug: it did not exist at all)', () => {
    const svc = makeMockService();
    expect(typeof svc.getNodeInfo).toBe('function');
  });

  it('returns a populated node info object without throwing', async () => {
    const svc = makeMockService();
    const info = await svc.getNodeInfo();
    expect(info.pubkey).toEqual(expect.any(String));
    expect(info.alias).toBe('Strawberry Mock Node');
    expect(typeof info.activeChannels).toBe('number');
    expect(typeof info.peers).toBe('number');
    expect(typeof info.synced).toBe('boolean');
  });
});

describe('LightningService.listChannels(): public method exists and works via the mock', () => {
  it('is a function on the service (the core bug: it did not exist at all)', () => {
    const svc = makeMockService();
    expect(typeof svc.listChannels).toBe('function');
  });

  it('returns an array of channel objects without throwing', async () => {
    const svc = makeMockService();
    const channels = await svc.listChannels();
    expect(Array.isArray(channels)).toBe(true);
    expect(channels.length).toBeGreaterThan(0);
    expect(typeof channels[0].active).toBe('boolean');
    expect(typeof channels[0].remotePubkey).toBe('string');
    expect(typeof channels[0].capacity).toBe('number');
  });

  it('aliases the internal chanId field as channelId (matches the payment route\'s expected shape)', async () => {
    const svc = makeMockService();
    const channels = await svc.listChannels();
    expect(channels[0].channelId).toBe(channels[0].chanId);
    expect(channels[0].channelId).toBeTruthy();
  });
});

describe('mock LND getInfo/listChannels: fixed calling-convention (request, callback)', () => {
  it('this.lnd.getInfo(request, callback) does not throw "callback is not a function"', () => {
    const svc = makeMockService();
    expect(() => {
      svc.lnd.getInfo({}, (err, response) => {
        expect(err).toBeNull();
        expect(response.identity_pubkey).toEqual(expect.any(String));
      });
    }).not.toThrow();
  });

  it('this.lnd.listChannels(request, callback) does not throw "callback is not a function"', () => {
    const svc = makeMockService();
    expect(() => {
      svc.lnd.listChannels({}, (err, response) => {
        expect(err).toBeNull();
        expect(Array.isArray(response.channels)).toBe(true);
      });
    }).not.toThrow();
  });

  it('the mock channel includes total_satoshis_sent/received and unsettled_balance (avoids NaN in updateChannels parseInt)', async () => {
    const svc = makeMockService();
    // Exercise the real internal path end-to-end: updateChannels() parses these
    // fields with parseInt() and validates with Joi — if they were missing,
    // parseInt(undefined) => NaN would fail Joi validation and the channel
    // would be silently dropped (this.channels would stay empty).
    const channels = await svc.listChannels();
    expect(channels.length).toBeGreaterThan(0);
    expect(Number.isFinite(channels[0].totalSent)).toBe(true);
    expect(Number.isFinite(channels[0].totalReceived)).toBe(true);
    expect(Number.isFinite(channels[0].unsettledBalance)).toBe(true);
  });
});

describe('LightningService.initialize(): the auto-restart path no longer fails on getInfo', () => {
  it('updateNodeInfo() (called by initialize()) succeeds against the mock without throwing', async () => {
    const svc = makeMockService();
    await expect(svc.updateNodeInfo()).resolves.toBeUndefined();
    expect(svc.nodeInfo).not.toBeNull();
    expect(svc.nodeInfo.alias).toBe('Strawberry Mock Node');
  });
});
