// Lightweight per-key async mutex for Node.js.
// Serializes concurrent async operations that share the same key (e.g. orderId),
// preventing TOCTOU races where an await between a state check and a write
// allows a second request to observe stale state and duplicate an action.
const _queues = new Map();

async function withLock(key, fn) {
  const prev = _queues.get(key) ?? Promise.resolve();
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  // Chain: next caller waits for tail to settle before running.
  // prev.then(...) が返す新 Promise を保持しておかないと、finally の
  // 「自分が末尾か」判定が永久に偽になり、キーごとのエントリが
  // Map に残り続ける（＝長時間運転でのメモリリーク）ため tail を退避する。
  const tail = prev.then(() => lock);
  _queues.set(key, tail);
  // tail の未処理リジェクション警告を抑止（prev が既に settle 済みでも
  // .then の返り値は握り潰されないよう noop catch を付ける）
  tail.catch(() => {});
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up entry once no waiters remain
    if (_queues.get(key) === tail) _queues.delete(key);
  }
}

// テスト/診断用: 滞留中のロックキュー数。0 に収束しない場合はリークを示す。
function pendingLockCount() { return _queues.size; }

module.exports = { withLock, pendingLockCount };
