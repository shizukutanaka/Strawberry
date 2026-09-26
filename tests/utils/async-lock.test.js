// withLock のロックマップ枯渇リグレッション:
// 旧実装は `prev.then(() => lock)` で生成した派生 Promise を _queues に保存する一方、
// finally の削除判定を `=== lock`（内部 Promise）と比較していたため常に偽となり、
// ユニークキーごとにエントリが永久に残り続けていた（長時間運転でのメモリリーク）。
const { withLock, pendingLockCount } = require('../../src/utils/async-lock');
describe('withLock', () => {
  it('serializes concurrent work for the same key', async () => {
    let running = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const job = () => withLock('k', async () => {
      calls += 1;
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 10));
      running -= 1;
    });
    await Promise.all([job(), job(), job()]);
    expect(calls).toBe(3);
    expect(maxConcurrent).toBe(1);
  });

  it('does not serialize different keys', async () => {
    const order = [];
    await Promise.all([
      withLock('a', async () => { await new Promise(r => setTimeout(r, 20)); order.push('a'); }),
      withLock('b', async () => { order.push('b'); }),
    ]);
    // b は a の完了を待たないので先に終わる
    expect(order[0]).toBe('b');
    expect(order[1]).toBe('a');
  });

  it('returns fn result and propagates errors', async () => {
    await expect(withLock('x', async () => 42)).resolves.toBe(42);
    await expect(withLock('x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // エラー後も同キーで再実行できる（ロックがリークして次回が永久に待機しない）
    await expect(withLock('x', async () => 'after-error')).resolves.toBe('after-error');
  });

  it('drains the internal queue map after all locks settle (no leak)', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `leak-check-${i}`);
    await Promise.all(keys.map(k => withLock(k, async () => {
      await new Promise(r => setTimeout(r, 1));
    })));
    // 全ロックが settle すればエントリは残らない（旧実装では常に残っていた）
    // マイクロタスクの flush を挟んでから観測する
    await new Promise(r => setImmediate(r));
    expect(pendingLockCount()).toBe(0);
  });
});
