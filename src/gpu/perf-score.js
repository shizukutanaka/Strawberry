// src/gpu/perf-score.js
// 機種横断で比較可能な正規化性能スコア（DLPerf 風）。
// docs/improvement-research-2026.md §12「標準ベンチマーク・ホスト信頼性スコア」の
// 前半（性能側）を埋める。ホスト信頼性側は既に src/reputation/provider-uptime.js が担当。
//
// 背景:
//   Vast.ai は機種横断で比較できる単一指標 DLPerf と、その価格比 DLPerf/$ を提示しており、
//   借り手は「どの GPU が速いか」ではなく「どの GPU が一番お得か」で選べる。Strawberry は
//   価格・メモリ容量でしか並べ替えられず、H100 と T4 の性能差を借り手が自力で調べる必要が
//   あった。本モジュールはその比較軸を提供する。
//
// 参考:
//   - Vast.ai DLPerf（機種横断の正規化 DL 性能指標 / DLPerf per dollar）
//   - Roofline model (Williams, Waterman, Patterson, CACM 2009) — 実効性能は演算律速と
//     メモリ帯域律速の両方に支配される。単一の TFLOPS 値だけでは順位を誤る。
//   - Agora: Bridging the GPU Cloud Resource-Price Disconnect, arXiv:2510.05111 —
//     価格を実消費資源（特徴量）に整合させる。本スコアは src/pricing/feature-pricer.js の
//     `benchmarkScore` 入力（参照GPU=100 の正規化スケール）と同じ土俵で設計してある。
//
// 設計上の約束（重要）:
//   1. **自己申告値で順位を買えないこと**。プロバイダが送れる performance.teraflops は
//      「型番が参照表に無い場合」にのみ、しかも消費電力から導いた物理的上限
//      (MAX_TFLOPS_PER_WATT) でクランプしてから使う。
//   2. **矛盾した申告に高スコアを与えないこと**。「H100」を名乗りつつ VRAM 24GB のような
//      参照表と矛盾する出品は、参照表の値を使わず申告ベースへ格下げし findings を返す。
//   3. **分からないものは null**。型番不明かつ申告性能も無い場合はスコアを推測せず
//      `score: null / confidence: 'unknown'` を返す（既存の reliability「計測中」と同じ
//      正直なUI原則）。
//
// 本モジュールは純関数のみ・依存ゼロ。インフラ非依存でテスト可能。

// --- 参照表 ---------------------------------------------------------------
// 公開スペックのおおよその値（dense FP16/BF16 テンソル TFLOPS・メモリ帯域 GB/s・VRAM GB・
// カタログ TDP W）。tdpWatt は出品時に powerWatt が申告されなかったときの既定値に使う
// （消費電力は出品者が手元で調べにくい一方、機種が分かれば公開値がある）。
// sparsity 2x 表記のカタログ値は dense に揃えてある。あくまで**順位付けのための近似**であり、
// 実測スループットの予測値ではない。SKU 差（SXM/PCIe 等）は代表値に丸めている。
const MODEL_TABLE = {
  // NVIDIA データセンター
  'h100 sxm': { fp16Tflops: 989, memBandwidthGBs: 3350, vramGB: 80, tdpWatt: 700 },
  'h100 pcie': { fp16Tflops: 756, memBandwidthGBs: 2000, vramGB: 80, tdpWatt: 350 },
  'h100': { fp16Tflops: 989, memBandwidthGBs: 3350, vramGB: 80, tdpWatt: 700 },
  'h200': { fp16Tflops: 989, memBandwidthGBs: 4800, vramGB: 141, tdpWatt: 700 },
  'b200': { fp16Tflops: 2250, memBandwidthGBs: 8000, vramGB: 192, tdpWatt: 1000 },
  'a100 80gb': { fp16Tflops: 312, memBandwidthGBs: 2039, vramGB: 80, tdpWatt: 400 },
  'a100 40gb': { fp16Tflops: 312, memBandwidthGBs: 1555, vramGB: 40, tdpWatt: 400 },
  'a100': { fp16Tflops: 312, memBandwidthGBs: 2039, vramGB: 80, tdpWatt: 400 },
  'l40s': { fp16Tflops: 362, memBandwidthGBs: 864, vramGB: 48, tdpWatt: 350 },
  'l40': { fp16Tflops: 181, memBandwidthGBs: 864, vramGB: 48, tdpWatt: 300 },
  'l4': { fp16Tflops: 121, memBandwidthGBs: 300, vramGB: 24, tdpWatt: 72 },
  'a10': { fp16Tflops: 125, memBandwidthGBs: 600, vramGB: 24, tdpWatt: 150 },
  'a10g': { fp16Tflops: 140, memBandwidthGBs: 600, vramGB: 24, tdpWatt: 150 },
  'v100': { fp16Tflops: 125, memBandwidthGBs: 900, vramGB: 32, tdpWatt: 300 },
  't4': { fp16Tflops: 65, memBandwidthGBs: 320, vramGB: 16, tdpWatt: 70 },
  // NVIDIA ワークステーション
  'rtx 6000 ada': { fp16Tflops: 364, memBandwidthGBs: 960, vramGB: 48, tdpWatt: 300 },
  'rtx a6000': { fp16Tflops: 155, memBandwidthGBs: 768, vramGB: 48, tdpWatt: 300 },
  'rtx a5000': { fp16Tflops: 111, memBandwidthGBs: 768, vramGB: 24, tdpWatt: 230 },
  // NVIDIA コンシューマ（rtx 4090 = 参照GPU）
  'rtx 5090': { fp16Tflops: 419, memBandwidthGBs: 1792, vramGB: 32, tdpWatt: 575 },
  'rtx 5080': { fp16Tflops: 225, memBandwidthGBs: 960, vramGB: 16, tdpWatt: 360 },
  'rtx 4090': { fp16Tflops: 165.2, memBandwidthGBs: 1008, vramGB: 24, tdpWatt: 450 },
  'rtx 4080': { fp16Tflops: 97.5, memBandwidthGBs: 717, vramGB: 16, tdpWatt: 320 },
  'rtx 4070': { fp16Tflops: 58, memBandwidthGBs: 504, vramGB: 12, tdpWatt: 200 },
  'rtx 3090': { fp16Tflops: 71, memBandwidthGBs: 936, vramGB: 24, tdpWatt: 350 },
  'rtx 3080': { fp16Tflops: 59.5, memBandwidthGBs: 760, vramGB: 10, tdpWatt: 320 },
  'rtx 3070': { fp16Tflops: 40.6, memBandwidthGBs: 448, vramGB: 8, tdpWatt: 220 },
  'rtx 3060': { fp16Tflops: 25.6, memBandwidthGBs: 360, vramGB: 12, tdpWatt: 170 },
  // AMD
  'mi300x': { fp16Tflops: 1307, memBandwidthGBs: 5300, vramGB: 192, tdpWatt: 750 },
  'mi250x': { fp16Tflops: 383, memBandwidthGBs: 3277, vramGB: 128, tdpWatt: 560 },
  'mi210': { fp16Tflops: 181, memBandwidthGBs: 1638, vramGB: 64, tdpWatt: 300 },
  'rx 7900 xtx': { fp16Tflops: 123, memBandwidthGBs: 960, vramGB: 24, tdpWatt: 355 },
  // Intel
  'max 1550': { fp16Tflops: 832, memBandwidthGBs: 3277, vramGB: 128, tdpWatt: 600 },
  'arc a770': { fp16Tflops: 39, memBandwidthGBs: 560, vramGB: 16, tdpWatt: 225 },
};

// 参照GPU（この機種のスコアが 100 になる）。feature-pricer の reference と同一機種:
// vramGB 24 / memBandwidthGBs ~1000 / benchmarkScore 100 は RTX 4090 級を指している。
const REFERENCE = { fp16Tflops: 165.2, memBandwidthGBs: 1008, vramGB: 24 };
const REFERENCE_MODEL = 'rtx 4090';

// 幾何平均の重み。演算・帯域・容量のいずれかが欠けても、残りを再正規化して使う。
// 演算を最大にするのは学習/推論いずれもテンソル演算が主因のため。容量を小さく残すのは
// 「モデルが載らない GPU は速くても使えない」という離散的な効用を弱く反映するため。
const WEIGHTS = { compute: 0.55, bandwidth: 0.3, vram: 0.15 };

// 申告 TFLOPS を受け入れる物理的上限（TFLOPS/W）。dense FP16 の実機効率は最良でも
// H100 SXM ≈ 989/700 ≒ 1.41、B200 ≈ 2250/1000 = 2.25。2.5 を上限に置けば実在機種を
// 弾かずに「300W で 5000 TFLOPS」のような水増し申告だけを潰せる。
const MAX_TFLOPS_PER_WATT = 2.5;

// 参照表に無い型番の申告ベース・スコアの上限（＝参照GPU と同点）。
// 電力上限クランプ（MAX_TFLOPS_PER_WATT）だけでは、大電力を申告した無名 GPU が
// 検証ゼロのまま H100 超えのスコアと価格対性能トップを取れてしまう。既知でも実機検証済み
// でもないハードウェアが参照GPU を追い越すことは許さない、という明示的な設計判断。
// 正当な新型 GPU は MODEL_TABLE への追加、またはアテステーション提出で上限を外れる。
const UNKNOWN_MODEL_SCORE_CAP = 100;

// 参照表と申告値の許容乖離。
const VRAM_TOLERANCE_PCT = 10;   // VRAM は SKU が決まれば一意 → 厳しめ
const TFLOPS_TOLERANCE_PCT = 50; // TFLOPS は測定条件で振れる → 緩め

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 型番文字列を参照表のキー形式へ正規化する。
 * 「NVIDIA GeForce RTX 4090」「rtx-4090」「RTX4090」→ 'rtx 4090'
 */
function normalizeModelName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.toLowerCase();
  // ベンダー名・マーケティング語・括弧内注記を除去
  s = s.replace(/\((?:[^()]*)\)/g, ' ');
  s = s.replace(/\b(nvidia|geforce|amd|radeon|intel|instinct|tesla|quadro|data\s*center|gpu)\b/g, ' ');
  // 区切り文字を空白へ
  s = s.replace(/[_\-/,]+/g, ' ');
  // 「rtx4090」のように密着した英字＋数字を分離する。分離するのは既知のシリーズ接頭辞
  // だけに限る: 汎用に `[a-z]+\d+` を割ると 'a100' が 'a 100'、'mi300x' が 'mi 300x' に
  // なって参照表を引けなくなる。
  s = s.replace(/\b(rtx|gtx|rx|arc)(\d{3,4}[a-z]*)\b/g, '$1 $2');
  return s.replace(/\s+/g, ' ').trim();
}

// 参照表の照合パターンをモジュール読込時に一度だけ構築する。
// GPU 一覧の ?sort=perf|value は最大 200 件を比較するため、呼び出しごとに 30 本超の
// RegExp をコンパイルすると公開エンドポイントで無視できない CPU コストになる。
// 長いキーから順に並べ、'h100 sxm' が汎用キー 'h100' に食われないようにする。
// 単語境界での一致に限定する（'l4' が 'superl4x9000' 等に誤マッチするのを防ぐ）。
const MODEL_PATTERNS = Object.keys(MODEL_TABLE)
  .sort((a, b) => b.length - a.length)
  .map((key) => ({
    key,
    spec: MODEL_TABLE[key],
    re: new RegExp(`(^|\\s)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`),
  }));

/**
 * 正規化済み名称から参照表エントリを引く。
 * @returns {{key:string, spec:object}|null}
 */
function lookupModel(...candidates) {
  for (const cand of candidates) {
    const n = normalizeModelName(cand);
    if (!n) continue;
    for (const p of MODEL_PATTERNS) {
      if (p.re.test(n)) return { key: p.key, spec: p.spec };
    }
  }
  return null;
}

/** 相対乖離（%）。基準が 0 以下なら null。 */
function deviationPct(actual, expected) {
  if (actual == null || expected == null || expected <= 0) return null;
  return Math.abs(actual - expected) / expected * 100;
}

/**
 * 利用可能な次元だけで重み付き幾何平均を取る（欠損次元は重みごと除外して再正規化）。
 * @param {Array<{ratio:number, weight:number}>} terms
 * @returns {number|null}
 */
function weightedGeoMean(terms) {
  const usable = terms.filter((t) => t.ratio != null && t.ratio > 0 && t.weight > 0);
  if (usable.length === 0) return null;
  const wSum = usable.reduce((s, t) => s + t.weight, 0);
  const logSum = usable.reduce((s, t) => s + (t.weight / wSum) * Math.log(t.ratio), 0);
  return Math.exp(logSum);
}

/**
 * GPU 出品レコードから正規化性能スコアを算出する。
 *
 * スコアは **順位付けのための指数**であり、実測スループットの予測値ではない。
 * 参照GPU（RTX 4090 級）を 100 とし、幾何平均のため次元差は意図的に圧縮される
 * （例: H100 ≒ 460, A100 80GB ≒ 210, RTX 3090 ≒ 61）。
 *
 * @param {object} gpu 出品レコード
 *   { model, name, vendor, memoryGB, powerWatt, performance: { teraflops, benchmarkScore },
 *     attestation: { passed } }
 * @returns {{
 *   score: number|null,
 *   confidence: 'attested'|'reference'|'declared'|'unknown',
 *   matchedModel: string|null,
 *   basis: {fp16Tflops:number|null, memBandwidthGBs:number|null, vramGB:number|null, source:string},
 *   findings: string[]
 * }}
 */
function computePerfScore(gpu = {}) {
  const findings = [];
  const perf = (gpu && typeof gpu.performance === 'object' && gpu.performance) || {};
  const declaredVram = num(gpu.memoryGB);
  const declaredTflops = num(perf.teraflops);
  const powerWatt = num(gpu.powerWatt);

  const matched = lookupModel(gpu.model, gpu.name);

  // --- 参照表と申告値の矛盾チェック（詐称検出） ---------------------------
  // 矛盾があれば参照表は使わない。「H100」を名乗るだけで H100 のスコアが付くのを防ぐ。
  let trustTable = Boolean(matched);
  if (matched) {
    const vramDev = deviationPct(declaredVram, matched.spec.vramGB);
    if (vramDev != null && vramDev > VRAM_TOLERANCE_PCT) {
      findings.push(
        `vram_mismatch: 型番 "${matched.key}" の既知 VRAM は ${matched.spec.vramGB}GB だが申告は ${declaredVram}GB（乖離 ${Math.round(vramDev)}%）`
      );
      trustTable = false;
    }
    const tflopsDev = deviationPct(declaredTflops, matched.spec.fp16Tflops);
    if (tflopsDev != null && tflopsDev > TFLOPS_TOLERANCE_PCT) {
      findings.push(
        `teraflops_mismatch: 型番 "${matched.key}" の既知 FP16 は約 ${matched.spec.fp16Tflops} TFLOPS だが申告は ${declaredTflops} TFLOPS（乖離 ${Math.round(tflopsDev)}%）`
      );
      // TFLOPS は測定条件で振れるため、これ単独では参照表を捨てない（VRAM ほど決定的でない）。
    }
  }

  let basis;
  let confidence;
  if (trustTable) {
    basis = { ...matched.spec, source: `model-table:${matched.key}` };
    confidence = 'reference';
  } else {
    // 参照表が使えない → 申告値のみ。TFLOPS は消費電力由来の物理上限でクランプする。
    let fp16Tflops = declaredTflops;
    if (fp16Tflops != null && powerWatt != null) {
      const cap = powerWatt * MAX_TFLOPS_PER_WATT;
      if (fp16Tflops > cap) {
        findings.push(
          `teraflops_implausible: 申告 ${fp16Tflops} TFLOPS は ${powerWatt}W で物理的に到達不能（上限 ${Math.round(cap)} TFLOPS）。上限値でクランプした`
        );
        fp16Tflops = cap;
      }
    }
    basis = {
      fp16Tflops,
      // 帯域はスキーマに無く検証もできないため推測しない（欠損として重みを再正規化）。
      memBandwidthGBs: num(perf.memBandwidthGBs),
      vramGB: declaredVram,
      source: matched ? 'declared(model-table-rejected)' : 'declared',
    };
    confidence = fp16Tflops != null ? 'declared' : 'unknown';
  }

  const score = weightedGeoMean([
    { ratio: basis.fp16Tflops != null ? basis.fp16Tflops / REFERENCE.fp16Tflops : null, weight: WEIGHTS.compute },
    { ratio: basis.memBandwidthGBs != null ? basis.memBandwidthGBs / REFERENCE.memBandwidthGBs : null, weight: WEIGHTS.bandwidth },
    { ratio: basis.vramGB != null ? basis.vramGB / REFERENCE.vramGB : null, weight: WEIGHTS.vram },
  ]);

  if (score == null) {
    return { score: null, confidence: 'unknown', matchedModel: matched ? matched.key : null, basis, findings };
  }

  // 演算性能の根拠が無い（VRAM だけ）状態を「性能スコア」と称するのは誤誘導。
  // 容量だけで H100 と同等に見えてしまうため、算出不能として扱う。
  if (basis.fp16Tflops == null) {
    return {
      score: null,
      confidence: 'unknown',
      matchedModel: matched ? matched.key : null,
      basis,
      findings: findings.concat('insufficient_data: 演算性能（TFLOPS）の根拠が無いためスコアを算出しない'),
    };
  }

  // アテステーション合格＝申告スペックが実機レポートと照合済み。スコア値は変えず
  // 「その数値がどれだけ裏付けられているか」だけを引き上げる（正直なUI原則）。
  const attested = Boolean(gpu.attestation && gpu.attestation.passed === true);
  if (confidence === 'reference' && attested) {
    confidence = 'attested';
  }

  let scaled = score * 100;
  // 未知型番かつ未検証は参照GPU 超えを認めない（自己申告での順位買いを防ぐ）。
  if (confidence === 'declared' && !attested && scaled > UNKNOWN_MODEL_SCORE_CAP) {
    findings.push(
      `unverified_model_capped: 参照表に無い型番の自己申告スコア ${Math.round(scaled)} を上限 ${UNKNOWN_MODEL_SCORE_CAP} に制限した（アテステーション提出で解除）`
    );
    scaled = UNKNOWN_MODEL_SCORE_CAP;
  }

  return {
    score: Math.round(scaled * 10) / 10,
    confidence,
    matchedModel: matched ? matched.key : null,
    basis,
    findings,
  };
}

/**
 * 価格対性能（DLPerf/$ 相当）。「1 sats/時 あたり何点の性能か」。
 * @param {number|null} score computePerfScore の score
 * @param {number} pricePerHour sats/時
 * @returns {number|null}
 */
function perfPerCost(score, pricePerHour) {
  const s = num(score);
  const p = num(pricePerHour);
  if (s == null || p == null || p <= 0) return null;
  // 小数 4 桁。安価な GPU（数 sats/時）でも 0 に潰れない粒度。
  return Math.round((s / p) * 10000) / 10000;
}

/**
 * 出品レコードから、UI/API がそのまま載せられる性能サマリを作る。
 * @returns {{score, confidence, matchedModel, perfPerHourSat, basis, findings}}
 */
function summarize(gpu = {}) {
  const r = computePerfScore(gpu);
  return {
    score: r.score,
    confidence: r.confidence,
    matchedModel: r.matchedModel,
    perfPerHourSat: perfPerCost(r.score, gpu.pricePerHour),
    basis: r.basis,
    findings: r.findings,
  };
}

/**
 * GPU 出品レコードを src/pricing/feature-pricer.js の入力特徴量へ変換する。
 *
 * 出品レコードは `memoryGB` / `performance.teraflops` を持ち、feature-pricer は
 * `vramGB` / `memBandwidthGBs` / `benchmarkScore` を期待する——語彙が噛み合っておらず、
 * 実レコードをそのまま渡すと全特徴量が 0 と評価されて見積が価格フロアに張り付く。
 * ここで橋渡しし、欠けている `benchmarkScore` は本モジュールの正規化スコアで埋める
 * （feature-pricer の reference.benchmarkScore=100 は本スコアの参照GPU=100 と同一スケール）。
 *
 * 明示的に与えられた feature-pricer 語彙のフィールドは常に優先する（呼び出し側が
 * 特徴量を直接指定するユースケースを壊さない）。
 * @param {object} gpu 出品レコード、または feature-pricer 語彙のオブジェクト
 * @returns {{vramGB:number|undefined, memBandwidthGBs:number|undefined, benchmarkScore:number|undefined, generation?:string, generationScore?:number}}
 */
function toPricingFeatures(gpu = {}) {
  const r = computePerfScore(gpu);
  const features = {
    vramGB: num(gpu.vramGB) != null ? gpu.vramGB : (num(gpu.memoryGB) != null ? gpu.memoryGB : undefined),
    memBandwidthGBs: num(gpu.memBandwidthGBs) != null ? gpu.memBandwidthGBs
      : (r.basis.memBandwidthGBs != null ? r.basis.memBandwidthGBs : undefined),
    benchmarkScore: num(gpu.benchmarkScore) != null ? gpu.benchmarkScore
      : (r.score != null ? r.score : undefined),
  };
  if (typeof gpu.generation === 'string') features.generation = gpu.generation;
  if (num(gpu.generationScore) != null) features.generationScore = gpu.generationScore;
  return features;
}

module.exports = {
  computePerfScore,
  perfPerCost,
  summarize,
  toPricingFeatures,
  normalizeModelName,
  lookupModel,
  MODEL_TABLE,
  REFERENCE,
  REFERENCE_MODEL,
  WEIGHTS,
  MAX_TFLOPS_PER_WATT,
};
