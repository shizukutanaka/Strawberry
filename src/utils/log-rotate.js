// src/utils/log-rotate.js - 追記型ログのサイズ上限ローテーション
// winston transports.File は maxsize/maxFiles で回転するが、appendFileSync で
// 手動追記するログ（access-audit.log / db-access.log / gpu-events.log 等）には
// その機構が無く、無制限に肥大してディスク枯渇（ログ DoS）になり得た。
// appendFileSync と同じ同期 API で、追記前に statSync → 閾値超過なら 1 世代
// ローテート（.1）する。複数世代や世代圧縮は意図的に省く: これらは補助監査ログで、
// 1 世代保持で「直前ローテーション境界前後の記録」を十分に追える。
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // winston の maxsize=10MB と揃える

// ロックがこの時間を超えて残っていたらクラッシュ残留とみなして回収する。
// ローテーションは statSync+renameSync のみで数 ms のため、30 秒超はほぼ確実に残骸。
const LOCK_STALE_MS = 30 * 1000;

// ローテーションの「サイズ確認 → rename」を、同一ログファイルを共有する複数
// プロセス間で直列化する。mkdirSync は同一 fs 上で atomic なのでロックとして
// 使える（プロセス内 mutex では別 Node プロセスを防げない）。
//   これが無い場合、A が 11MB を検出して .1 へ rename した直後に、同じく 11MB を
//   検出済みの B が「A が作った新しいアクティブファイル」を .1 へ rename して
//   アーカイブを小さい新ファイルで上書きし、直前の記録を消失させる。
function _tryLock(lockPath) {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
    // 既存ロック — クラッシュ残留なら回収して再試行1回。
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
      fs.rmdirSync(lockPath);
      try {
        fs.mkdirSync(lockPath);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }
}

function _unlock(lockPath) {
  try { fs.rmdirSync(lockPath); } catch {}
}

/**
 * サイズ上限付きで行を追記する。
 * @param {string} filePath 追記先
 * @param {string} line 追記する行（改行含む）
 * @param {{maxBytes?: number}} [opts]
 */
function appendRotated(filePath, line, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  let oversized = false;
  try {
    oversized = fs.statSync(filePath).size > maxBytes;
  } catch (e) {
    // ENOENT（未作成）は正常。stat 失敗時はローテートせず追記に進む。
  }
  if (oversized) {
    const lockPath = `${filePath}.rotate-lock`;
    if (_tryLock(lockPath)) {
      try {
        // ロック内で再確認: 待機中に他プロセスがローテート済みならここで小さい
        // サイズが見え、rename は行わない（二重ローテートによる記録消失を防ぐ）。
        if (fs.statSync(filePath).size > maxBytes) {
          // .1 を上書き（2世代目以降は切り捨て）。rename は同一 fs 上で atomic。
          fs.renameSync(filePath, `${filePath}.1`);
        }
      } catch (e) {
        // 再 stat や rename の失敗は追記を阻害しない（ローテーションは最善努力）。
      } finally {
        _unlock(lockPath);
      }
    }
    // ロック取得失敗 = 他プロセスがローテート中。今回はローテートせず追記し、
    // 次の書き手が境界超過を検出した時点でローテートされる（超過は一時的）。
  }
  fs.appendFileSync(filePath, line);
}

/** ログディレクトリを初回のみ作成する（リクエスト毎の mkdirSync 回避用）。 */
const _readyDirs = new Set();
function ensureLogDir(filePath) {
  const dir = path.dirname(filePath);
  if (_readyDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  _readyDirs.add(dir);
}

module.exports = { appendRotated, ensureLogDir, DEFAULT_MAX_BYTES };
