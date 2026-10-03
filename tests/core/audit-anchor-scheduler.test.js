// tests/core/audit-anchor-scheduler.test.js
// AUDIT_ANCHOR_INTERVAL_HOURS の解釈・起動条件・単一フライトの契約を固定する。
// backup-scheduler.test.js と同型の構造。

const {
  startAuditAnchorScheduler,
  resolveIntervalMs,
} = require('../../src/core/audit-anchor-scheduler');

describe('audit-anchor-scheduler: resolveIntervalMs', () => {
  it('returns 0 when the env var is unset / empty / non-numeric / non-positive', () => {
    expect(resolveIntervalMs({})).toBe(0);
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: '' })).toBe(0);
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: 'abc' })).toBe(0);
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: '0' })).toBe(0);
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: '-2' })).toBe(0);
  });

  it('converts hours to milliseconds', () => {
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: '24' })).toBe(24 * 3600e3);
    expect(resolveIntervalMs({ AUDIT_ANCHOR_INTERVAL_HOURS: '0.5' })).toBe(30 * 60e3);
  });
});

describe('audit-anchor-scheduler: startAuditAnchorScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null when disabled (no env / zero interval)', () => {
    expect(startAuditAnchorScheduler({ intervalMs: 0 })).toBeNull();
  });

  it('returns null in test env unless allowInTest', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(startAuditAnchorScheduler({ intervalMs: 1000, anchor: () => {} })).toBeNull();
      expect(
        startAuditAnchorScheduler({ intervalMs: 1000, anchor: () => {}, allowInTest: true })
      ).not.toBeNull();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('fires the anchor function on the configured interval', async () => {
    jest.useFakeTimers();
    const anchor = jest.fn();
    const timer = startAuditAnchorScheduler({
      intervalMs: 1000,
      anchor,
      allowInTest: true,
    });
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(1000);
      // .catch→.finally の inFlight 解放 microtask を先に流す（fake timer 下では
      // advanceTimersByTime 単体では promise チェーンが進まない。catch 経由で2ホップ要）
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(anchor).toHaveBeenCalledTimes(3);
    clearInterval(timer);
  });

  it('does not overlap runs while the previous anchor is still in flight', async () => {
    jest.useFakeTimers();
    let resolve;
    const pending = new Promise(r => (resolve = r));
    const anchor = jest.fn(() => pending);
    const timer = startAuditAnchorScheduler({
      intervalMs: 1000,
      anchor,
      allowInTest: true,
    });
    jest.advanceTimersByTime(3000);
    expect(anchor).toHaveBeenCalledTimes(1); // 1 tick ran, later ticks skipped
    resolve();
    await pending; // inFlight 解放の promise チェーン完了を待つ
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(anchor).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it('survives a throwing anchor without killing the interval', () => {
    jest.useFakeTimers();
    const anchor = jest.fn(() => { throw new Error('boom'); });
    const timer = startAuditAnchorScheduler({
      intervalMs: 1000,
      anchor,
      allowInTest: true,
    });
    jest.advanceTimersByTime(2000);
    expect(anchor).toHaveBeenCalledTimes(2); // error logged, interval continues
    clearInterval(timer);
  });
});
