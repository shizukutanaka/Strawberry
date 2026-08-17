// src/verification/utilization-collector.js
// 稼働中レンタルの GPU 利用率サンプルを収集し、終了時にゼロ負荷課金を検出する
// （docs/improvement-research-2026.md §1 Proof-of-Compute の短期アクション2）。
//
// 背景: `src/verification/work-verifier.js` の `detectZeroLoad()` は実装済みだったが、
// 入力となる `utilSamples` は **admin が `/escrow/:id/verify` のリクエストボディで手渡す**
// 経路しか無く、実レンタルからは一度も呼ばれていなかった。つまり「借りた GPU が本当に
// 計算したか」を検証する仕組みは、部品はあっても稼働していなかった。本モジュールは
// ハートビートに相乗りしてサンプルを集め、その穴を埋める。
//
// --- 設計上いちばん重要な点: 片側の自己申告は証拠にならない -------------------
// 誰が利用率を知っているか:
//   - プロバイダのホスト（nvidia-smi）が実測値を持つ。しかし**検出したい不正の当事者**
//     なので、自己申告させても「常に 90%」と答えるだけで意味がない。
//   - 借り手は自分がジョブを投入したかを知っている。しかし返金目的で「ずっと遊休だった」と
//     偽る動機がある。
// したがって片方だけを集めても検証にならない。本モジュールは**両者から集めて食い違いを
// 検出する**。両者が遊休で一致すればゼロ負荷が確定し、食い違えばどちらかが偽っている証拠
// （＝係争の材料）になる。これは §1 の ternary consensus の考え方を、その場にいる 2 者へ
// 適用した最小形である。
//
// **これは暗号学的な証明ではない**。TEE アテステーション（§2）や再実行監査を代替するもの
// ではなく、「何もせず課金」という最も素朴な不正を、追加ハードウェア無しで検出可能にし、
// 双方の申告を突き合わせ可能な監査証跡として残すためのもの。
//
// 参考: arXiv:2501.05374（GPU profiling による確率的検証 / ternary consensus）,
//       arXiv:2208.03567（Proof-of-Learning は spoof 可能 — 単一の自己申告に依存しない）。

const { detectZeroLoad } = require('./work-verifier');

// 1 注文あたりの保持サンプル数の上限。ハートビート間隔（既定 10 秒下限）で長時間の
// レンタルが走ると無制限に増えるため、リングバッファで頭打ちにする。
// 500 サンプルあれば分布の判定には十分で、メモリも注文あたり数 KB に収まる。
const MAX_SAMPLES_PER_ROLE = 500;

// 判定に必要な最小サンプル数。数回のハートビートで「ゼロ負荷」と断じると、
// 起動直後やジョブ投入前の空白を不正と誤認する。
const MIN_SAMPLES_FOR_VERDICT = 5;

// orderId -> { lender: number[], renter: number[] }
const _samples = new Map();

function _bucket(orderId) {
  let b = _samples.get(orderId);
  if (!b) {
    b = { lender: [], renter: [] };
    _samples.set(orderId, b);
  }
  return b;
}

/**
 * 利用率サンプルを 1 件記録する。
 * @param {string} orderId
 * @param {'lender'|'renter'} role 申告者
 * @param {number} utilizationPct 0-100
 * @returns {boolean} 記録したか（不正な入力は無視して false）
 */
function record(orderId, role, utilizationPct) {
  if (!orderId || (role !== 'lender' && role !== 'renter')) return false;
  // 型強制をしない。`Number(null)` は 0（＝遊休）になるため、`utilizationPct: null` を
  // 送るだけで zero_load 側へ判定を寄せられてしまう。文字列 "85" も受けない（型混同を招く）。
  const v = utilizationPct;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return false;
  const arr = _bucket(orderId)[role];
  arr.push(v);
  // リングバッファ: 古いものから捨てる（直近の挙動の方が精算に近い）
  if (arr.length > MAX_SAMPLES_PER_ROLE) arr.splice(0, arr.length - MAX_SAMPLES_PER_ROLE);
  return true;
}

/** 収集済みサンプルを取得する（テスト・検査用）。 */
function getSamples(orderId) {
  const b = _samples.get(orderId);
  return { lender: b ? b.lender.slice() : [], renter: b ? b.renter.slice() : [] };
}

/** 注文終了時にサンプルを破棄する（メモリリーク防止）。 */
function clear(orderId) {
  _samples.delete(orderId);
}

/** テスト用: 全状態を破棄する。 */
function _reset() {
  _samples.clear();
}

/** 片側のサンプル列を判定する。サンプル不足なら断定しない。 */
function _judgeSide(samples, opts) {
  if (!Array.isArray(samples) || samples.length < MIN_SAMPLES_FOR_VERDICT) {
    return { verdict: 'insufficient', samples: samples ? samples.length : 0, activeRatio: null };
  }
  const r = detectZeroLoad(samples, opts);
  return {
    // detectZeroLoad は { suspectedZeroLoad, activeRatio, samples } を返す
    verdict: r.suspectedZeroLoad ? 'idle' : 'active',
    samples: r.samples,
    activeRatio: r.activeRatio,
  };
}

/**
 * 収集したサンプルからゼロ負荷課金の疑いを判定する。
 *
 * 返す verdict:
 * - `no_data`        : どちらの側からもサンプルが無い（テレメトリ未対応クライアント等）
 * - `insufficient`   : サンプルが少なすぎて断定できない
 * - `active`         : 稼働していた（少なくとも一方が稼働を示し、矛盾しない）
 * - `zero_load`      : **両者が遊休で一致** — 何もしていない GPU に課金している疑い
 * - `disputed`       : 両者の申告が食い違う — どちらかが偽っている（係争の材料）
 *
 * @param {string} orderId
 * @param {object} opts detectZeroLoad へ渡す { minUtilPct, minActiveRatio }
 */
function assess(orderId, opts = {}) {
  const { lender, renter } = getSamples(orderId);
  if (lender.length === 0 && renter.length === 0) {
    return { verdict: 'no_data', lender: null, renter: null, assessedAt: new Date().toISOString() };
  }
  const l = _judgeSide(lender, opts);
  const r = _judgeSide(renter, opts);

  let verdict;
  if (l.verdict === 'idle' && r.verdict === 'idle') {
    // 両者が「遊休だった」で一致 — 偽る動機が逆向きの 2 者が同じことを言っている。
    verdict = 'zero_load';
  } else if (
    (l.verdict === 'idle' && r.verdict === 'active') ||
    (l.verdict === 'active' && r.verdict === 'idle')
  ) {
    // 食い違い。どちらが正しいかは本モジュールには判断できない（両者とも偽る動機を持つ）。
    // 自動で資金を動かさず、係争の材料として記録するに留める。
    verdict = 'disputed';
  } else if (l.verdict === 'active' || r.verdict === 'active') {
    verdict = 'active';
  } else {
    verdict = 'insufficient';
  }

  return { verdict, lender: l, renter: r, assessedAt: new Date().toISOString() };
}

module.exports = {
  record,
  getSamples,
  clear,
  assess,
  _reset,
  MAX_SAMPLES_PER_ROLE,
  MIN_SAMPLES_FOR_VERDICT,
};
