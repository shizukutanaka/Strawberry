// src/utils/sliding-window-limit.js
// キー単位の滑動ウィンドウレート制限（プロセス内 Map ベース）。
// hit() でカウントを進め、isLimited() で現在のカウントが上限到達かを読む。
// IP 単位・ユーザー単位・メールアドレス単位など、キーの意味は呼び出し側が決める。
// NOTE: プロセス内メモリのため、複数プロセス/再起動では状態を共有しない
// （login 失敗カウンタ等のブルートフォース対策は防御深層の一層として使う）。
function createSlidingWindowLimiter({ windowMs, max }) {
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
    return entry.count;
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
