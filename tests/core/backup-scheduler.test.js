// tests/core/backup-scheduler.test.js
//
// BACKUP_INTERVAL_HOURS opt-in の定期バックアップスケジューラの回帰テスト。
// 実害: utils/backup.js の backupAll は実装済みだが呼び出し側が皆無で、
// 手動実行以外ではバックアップが一切走らなかった。加えて backup.js は
// 任意クラウド SDK をトップレベル require するため、未導入環境では
// require 自体が失敗する — スケジューラはこの失敗を起動クラッシュではなく
// 警告+無効化として扱う必要がある。

const { startBackupScheduler, stopBackupScheduler, resolveIntervalMs } = require('../../src/core/backup-scheduler');

describe('backup-scheduler: resolveIntervalMs', () => {
  it('returns 0 (disabled) when BACKUP_INTERVAL_HOURS is unset or empty', () => {
    expect(resolveIntervalMs({})).toBe(0);
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: '' })).toBe(0);
  });

  it('returns 0 for zero, negative, and non-numeric values', () => {
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: '0' })).toBe(0);
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: '-2' })).toBe(0);
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: 'abc' })).toBe(0);
  });

  it('converts hours to milliseconds', () => {
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: '24' })).toBe(86400000);
    expect(resolveIntervalMs({ BACKUP_INTERVAL_HOURS: '0.5' })).toBe(1800000);
  });
});

describe('backup-scheduler: startBackupScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns null when disabled by env (unset)', () => {
    const saved = process.env.BACKUP_INTERVAL_HOURS;
    delete process.env.BACKUP_INTERVAL_HOURS;
    try {
      expect(startBackupScheduler()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.BACKUP_INTERVAL_HOURS = saved;
    }
  });

  it('returns null in test env even with interval set (timer-leak prevention)', () => {
    const calls = [];
    const timer = startBackupScheduler({
      intervalMs: 3600e3,
      backupAll: async () => { calls.push(1); },
      // allowInTest omitted — NODE_ENV=test must suppress
    });
    expect(timer).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('runs backupAll on each tick when allowInTest (injected fn)', async () => {
    jest.useFakeTimers();
    const calls = [];
    const timer = startBackupScheduler({
      intervalMs: 1000,
      backupAll: async () => { calls.push(Date.now()); },
      allowInTest: true,
    });
    expect(timer).not.toBeNull();
    // advance per-tick: the single-flight flag clears on the microtask queue,
    // so ticks fired back-to-back within one advanceTimersByTime would be skipped
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); await Promise.resolve();
    }
    expect(calls.length).toBe(3);
    clearInterval(timer);
  });

  it('single-flight: a still-running backup suppresses the next tick', async () => {
    jest.useFakeTimers();
    let resolveBlocking;
    const calls = [];
    const backupAll = jest.fn(() => {
      calls.push(1);
      return new Promise(r => { resolveBlocking = r; });
    });
    const timer = startBackupScheduler({ intervalMs: 1000, backupAll, allowInTest: true });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(1);
    // second tick fires while first is still pending — must be skipped
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(1);
    resolveBlocking();
    await Promise.resolve(); await Promise.resolve();
    // third tick runs normally after completion
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });

  it('a throwing backupAll is caught and does not kill the scheduler', async () => {
    jest.useFakeTimers();
    let i = 0;
    const backupAll = jest.fn(async () => {
      i++;
      if (i === 1) throw new Error('disk full');
    });
    const timer = startBackupScheduler({ intervalMs: 1000, backupAll, allowInTest: true });
    jest.advanceTimersByTime(1000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve(); await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(2); // second tick still ran
    clearInterval(timer);
  });

  it('stopBackupScheduler() stops subsequent ticks (registry-stop contract)', async () => {
    jest.useFakeTimers();
    const backupAll = jest.fn(async () => {});
    startBackupScheduler({ intervalMs: 1000, backupAll, allowInTest: true });
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(1);
    stopBackupScheduler();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(1); // no further ticks after stop
  });

  it('a second start replaces the timer instead of stacking (re-init safety)', async () => {
    jest.useFakeTimers();
    const first = jest.fn(async () => {});
    const second = jest.fn(async () => {});
    startBackupScheduler({ intervalMs: 1000, backupAll: first, allowInTest: true });
    startBackupScheduler({ intervalMs: 1000, backupAll: second, allowInTest: true });
    jest.advanceTimersByTime(2000);
    await Promise.resolve(); await Promise.resolve();
    // only the newest scheduler fires — the old timer was cleared, not orphaned
    expect(first).toHaveBeenCalledTimes(0);
    expect(second).toHaveBeenCalledTimes(2);
    stopBackupScheduler();
  });

  it('re-calling start when disabled clears an existing timer', async () => {
    jest.useFakeTimers();
    const backupAll = jest.fn(async () => {});
    startBackupScheduler({ intervalMs: 1000, backupAll, allowInTest: true });
    startBackupScheduler({ intervalMs: 0, backupAll, allowInTest: true }); // disabled re-eval
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(backupAll).toHaveBeenCalledTimes(0);
  });
});
