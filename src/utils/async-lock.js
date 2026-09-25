// Lightweight per-key async mutex for Node.js.
// Serializes concurrent async operations that share the same key (e.g. orderId),
// preventing TOCTOU races where an await between a state check and a write
// allows a second request to observe stale state and duplicate an action.
const _queues = new Map();

async function withLock(key, fn) {
  const prev = _queues.get(key) ?? Promise.resolve();
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  // Chain: next caller waits for lock to release before running.
  // 後続が連結するのは chain（thenable）。lock 自体は Map に入らないため、
  // クリーンアップ判定は格納した chain との一致で行う — lock と比較すると
  // 常に false になり、ユニークキーごとにエントリが残り続けるリークになる。
  const chain = prev.then(() => lock);
  _queues.set(key, chain);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up entry once no waiters remain
    if (_queues.get(key) === chain) _queues.delete(key);
  }
}

module.exports = { withLock };
