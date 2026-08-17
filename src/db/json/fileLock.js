// src/db/json/fileLock.js
// JSON データファイル用のクロスプロセス排他ロック（ARCHITECTURE.md「既知の重大ギャップ:
// JSON 層のクロスプロセス lost-update」）。
//
// 問題: `createJsonRepository` の書き込みは `atomicWrite`（temp+rename）で**書き込み自体は
// 原子的**だが、`load() → 変更 → write()` という read-modify-write の**シーケンス全体は
// 保護されていない**。単一プロセスなら Node が単一スレッドで、load と write の間に await が
// 無いため安全だが、PM2 クラスタ・別ワーカー・CLI ツールを同時に動かすと:
//     P1: load() → [rows A,B]        P2: load() → [rows A,B]
//     P1: A を更新 → write([A',B])    P2: B を更新 → write([A,B'])
//   最後に書いた方が勝ち、もう一方の更新は**消える**。orders/payments/escrows で起きれば
//   資金記録の消失になる。
//
// 技術的背景:
//   - POSIX の `flock(2)` / `fcntl(2)` が本来の解だが、Node.js に組み込みバインディングが無く、
//     `fs-ext` 等のネイティブモジュールが必要になる（このリポジトリの依存方針に合わない）。
//   - 代わりに **`open(2)` の `O_CREAT|O_EXCL`**（Node では `openSync(path, 'wx')`）を使う。
//     これは POSIX が原子性を保証する古典的なロックファイル手法で、ローカル FS では確実に
//     「作成に成功したプロセスがちょうど 1 つ」になる。
//     （NFS v2 では O_EXCL の原子性が保証されないことで知られるが、本プロジェクトの想定は
//     ローカルディスク。ネットワーク FS 上で運用するなら本当の DB へ移行すべき。）
//   - リポジトリの API は同期関数なので、ロックも**同期**でなければならない。
//     `proper-lockfile` 等の一般的なライブラリは非同期前提のため使えない。同期スリープには
//     `Atomics.wait()` を使う（Node のメインスレッドでは許可されている。ビジーループと違い
//     CPU を焼かない）。
//
// 読み取りにロックは要らない: 書き込みが rename で原子的に差し替わるため、読み手が
// 中途半端なファイルを見ることはない（torn read が起きない）。守るべきは
// read-modify-write の系列だけである。

const fs = require('fs');
const path = require('path');

// ロック取得を諦めるまでの上限。超えたら**黙って処理を続けずに throw する**。
// ロック無しで書き込みを続行すると、まさに防ごうとしている lost-update が
// サイレントに起きる。資金記録が静かに消えるより、明示的に失敗する方がよい。
const DEFAULT_TIMEOUT_MS = 5000;

// この時間を超えて保持されているロックは、保持プロセスが異常終了したとみなして奪う。
// read-modify-write は通常ミリ秒で終わる（fsync 込みでも）ので 2 秒は 3 桁の余裕がある。
// タイムアウト(5s)より十分小さくしないと、stale ロックを奪う前に諦めてしまう。
const DEFAULT_STALE_MS = 2000;

// 再試行間隔。短すぎると無駄な syscall、長すぎると待ち時間が伸びる。
const RETRY_INTERVAL_MS = 3;

// 同一プロセス内での再入を許す（同じパスのロックを入れ子で取っても自己デッドロックしない）。
// path -> depth
const _held = new Map();

// Atomics.wait による同期スリープ。ビジーウェイトと違い CPU を消費しない。
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

function lockPathFor(targetPath) {
  return `${targetPath}.lock`;
}

/** ロックが stale（保持プロセスが死んだ）かどうか。判定できない場合は false（安全側）。 */
function isStale(lockPath, staleMs) {
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    return age > staleMs;
  } catch (_) {
    // stat 失敗 = ちょうど解放された等。stale とは断定しない。
    return false;
  }
}

/**
 * ロックを取得する。取得できたら解放用の関数を返す。
 * @param {string} targetPath 保護対象のデータファイル
 * @param {object} opts { timeoutMs, staleMs }
 * @returns {() => void} release
 */
function acquire(targetPath, { timeoutPassMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  const lockPath = lockPathFor(targetPath);

  // 再入: 既にこのプロセスが持っているなら深さを増やすだけ。
  const depth = _held.get(lockPath);
  if (depth !== undefined) {
    _held.set(lockPath, depth + 1);
    return () => {
      const d = _held.get(lockPath);
      if (d === undefined) return;
      if (d <= 1) _held.delete(lockPath);
      else _held.set(lockPath, d - 1);
    };
  }

  const deadline = Date.now() + timeoutPassMs;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      // 'wx' = O_CREAT|O_EXCL。作成に成功したプロセスがちょうど 1 つになる（POSIX 保証）。
      const fd = fs.openSync(lockPath, 'wx');
      try {
        // 保持者の情報を書いておく（運用時の詰まり調査用。正しさには関与しない）。
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } catch (_) { /* 診断情報の書き込み失敗はロックの有効性に影響しない */ }
      fs.closeSync(fd);
      _held.set(lockPath, 1);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const d = _held.get(lockPath);
        if (d !== undefined && d > 1) { _held.set(lockPath, d - 1); return; }
        _held.delete(lockPath);
        try { fs.unlinkSync(lockPath); } catch (_) { /* 既に奪われた/消えた */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // 保持プロセスが死んでロックが残っていると、以降のすべての書き込みが永久に詰まる。
      // 十分に古いロックは奪う。unlink してから再度 'wx' で作り直すので、複数プロセスが
      // 同時に奪おうとしても作成に成功するのは 1 つだけ（原子性は open(O_EXCL) が担保）。
      if (isStale(lockPath, staleMs)) {
        try { fs.unlinkSync(lockPath); } catch (_) { /* 他プロセスが先に奪った */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[json-lock] timed out after ${timeoutPassMs}ms waiting for ${path.basename(lockPath)}. `
          + 'Refusing to write without the lock — proceeding would risk a silent lost update.'
        );
      }
      sleepSync(RETRY_INTERVAL_MS);
    }
  }
}

/**
 * ロックを保持したまま fn を実行する（同期）。例外時も必ず解放する。
 * @param {string} targetPath 保護対象のデータファイル
 * @param {Function} fn
 * @param {object} opts
 */
function withFileLock(targetPath, fn, opts = {}) {
  const release = acquire(targetPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/** テスト用: プロセス内の保持状態を破棄する（ロックファイル自体は消さない）。 */
function _resetHeld() {
  _held.clear();
}

module.exports = {
  withFileLock,
  acquire,
  lockPathFor,
  isStale,
  _resetHeld,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_MS,
};
