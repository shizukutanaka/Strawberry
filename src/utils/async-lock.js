// Lightweight per-key async mutex for Node.js.
// Serializes concurrent async operations that share the same key (e.g. orderId),
// preventing TOCTOU races where an await between a state check and a write
// allows a second request to observe stale state and duplicate an action.
const _queues = new Map();

async function withLock(key, fn) {
  const prev = _queues.get(key) ?? Promise.resolve();
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  // Chain: next caller waits for lock to release before running
  _queues.set(key, prev.then(() => lock));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up entry once no waiters remain
    if (_queues.get(key) === lock) _queues.delete(key);
  }
}

module.exports = { withLock };
