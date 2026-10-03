// src/utils/async-lock.js — per-key async mutex の動作契約を固定するテスト。
// withLock は注文・GPU ブロック・係争カウンタ等の全クリティカル並行経路で使われる
// プリミティブだが直接テストが無かった。以下を固定する:
//   - 同一キーの直列化（fn が先行呼出しの完了まで実行されない）
//   - 異なるキーの非直列化（グローバルロックではない）
//   - fn の戻り値・rejection の伝播
//   - rejection 後もロックが解放される（次の待機者がデッドロックしない）
//   - キューされた呼出しが投入順（FIFO）で実行される
const { withLock } = require('../../src/utils/async-lock');

describe('withLock', () => {
  it('serializes concurrent calls on the same key', async () => {
    const order = [];
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const p1 = withLock('k1', async () => {
      order.push('a-start');
      await gate;
      order.push('a-end');
      return 'a';
    });
    const p2 = withLock('k1', async () => { order.push('b'); return 'b'; });
    // p1 がゲート待ちの間は p2 の fn は開始されない
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['a-start']);
    releaseFirst();
    await expect(p1).resolves.toBe('a');
    await expect(p2).resolves.toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('does not serialize calls on different keys', async () => {
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const pa = withLock('ka', () => gateA.then(() => 'a'));
    const pb = withLock('kb', async () => 'b');
    // kb は ka のゲートにブロックされず即座に完了する
    await expect(pb).resolves.toBe('b');
    releaseA();
    await expect(pa).resolves.toBe('a');
  });

  it('returns the fn result', async () => {
    await expect(withLock('k3', async () => 42)).resolves.toBe(42);
    await expect(withLock('k3', async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it('propagates fn rejection and still releases the lock', async () => {
    const boom = new Error('boom');
    await expect(withLock('k4', async () => { throw boom; })).rejects.toBe(boom);
    // rejection 後も同キーの次の待機者は実行される（デッドロックしない）
    await expect(withLock('k4', async () => 'next')).resolves.toBe('next');
  });

  it('propagates sync throw and still releases the lock', async () => {
    await expect(withLock('k5', () => { throw new Error('sync'); })).rejects.toThrow('sync');
    await expect(withLock('k5', async () => 'after')).resolves.toBe('after');
  });

  it('runs queued calls in FIFO order', async () => {
    const finished = [];
    const mk = (name, delayMs) => withLock('k6', async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      finished.push(name);
    });
    // 後続ほど短い delay でも、投入順に完了する（直列化の帰結）
    const ps = [mk('first', 30), mk('second', 10), mk('third', 0)];
    await Promise.all(ps);
    expect(finished).toEqual(['first', 'second', 'third']);
  });

  it('serializes a read-modify-write counter under concurrency', async () => {
    // TOCTOU 防止という使用目的そのものの回帰固定:
    // 非原子的な read→inc→write を withLock 内で行うと加算が消失しない
    let counter = 0;
    const inc = () => withLock('counter', async () => {
      const cur = counter;
      await new Promise((r) => setImmediate(r)); // インターリーブ機会を作る
      counter = cur + 1;
    });
    await Promise.all([inc(), inc(), inc(), inc(), inc()]);
    expect(counter).toBe(5);
  });
});
