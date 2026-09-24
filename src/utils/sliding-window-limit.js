// src/utils/sliding-window-limit.js
// キー単位の滑動ウィンドウレート制限（プロセス内 Map ベース）。
// hit() でカウントを進め、isLimited() で現在のカウントが上限到達かを読む。
// IP 単位・ユーザー単位・メールアドレス単位など、キーの意味は呼び出し側が決める。
// NOTE: プロセス内メモリのため、複数プロセス/再起動では状態を共有しない
// （login 失敗カウンタ等のブルートフォース対策は防御深層の一層として使う）。
function createSlidingWindowLimiter({ windowMs, max, maxKeys = 100000 }) {
  const state = new Map(); // key -> { count, windowStart }

  function hit(key) {
    const now = Date.now();
    const entry = state.get(key) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    state.set(key, entry);
    pruneIfOversized(now);
    return entry.count;
  }

  // 失効済みキーは isLimited/reset が同じキーを再度読まない限り Map に
  // 残り続けるため、ユニークキーの噴霧（攻撃元の IP・メール列挙）で state が
  // 無制限に成長するのを maxKeys で防ぐ。上限超過時はまず失効キーを全て
  // 捨て、なお超過なら最古の窓から追い出す（直前に hit したキーの
  // windowStart は最新なので、追い出し対象に即選ばれることはない）。
  function pruneIfOversized(now) {
    if (state.size <= maxKeys) return;
    for (const [k, e] of state) {
      if (now - e.windowStart > windowMs) state.delete(k);
    }
    const overflow = state.size - maxKeys;
    if (overflow <= 0) return;
    const byAge = [...state.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    for (let i = 0; i < overflow && i < byAge.length; i++) state.delete(byAge[i][0]);
  }

  function isLimited(key) {
    const entry = state.get(key);
    if (!entry) return false;
    if (Date.now() - entry.windowStart > windowMs) {
      state.delete(key);
      return false;
    }
    return entry.count >= max;
  }

  function reset(key) {
    state.delete(key);
  }

  return { hit, isLimited, reset, state };
}

module.exports = { createSlidingWindowLimiter };
