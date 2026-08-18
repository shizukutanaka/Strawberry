// src/gpu/listing-defaults.js
// 出品時の申告項目を「人が手元で分かること」だけに絞り、残りは機種から導出する。
//
// ── なぜ必要だったか（要件の見直し）────────────────────────────────────────
// `POST /gpus` は 10 項目を必須にしていた: name / vendor / model / apiType /
// driverVersion / os / arch / memoryGB / clockMHz / pricePerHour / powerWatt。
// 実サーバに対して出品を試したところ、貸し手が自然に答えられる 5 項目
// （名前・メーカー・機種・VRAM・時間単価）だけでは **400 で弾かれる**。
// 二面市場で最初に起きる行為が供給側の出品である以上、ここの摩擦は
// そのまま「供給ゼロ ＝ 市場が成立しない」に直結する。
//
// 各項目を「本当に必須か」で仕分けた結果:
//   apiType       … vendor から一意に決まる（NVIDIA→CUDA / AMD→ROCm / Intel→oneAPI）。
//                   聞く必要が無い。
//   arch          … 実質 x86_64。既定値でよく、違う人だけが直せばよい。
//   powerWatt     … 借り手の判断には効かないが、perf-score の TFLOPS/W 上限
//                   （性能の水増し検出）と carbon-intensity の排出量推定が使う。
//                   機種が分かればカタログ TDP がある → 参照表から導出する。
//   clockMHz      … どこも使っていない。表示のみ。任意でよい。
//   driverVersion … 同上。稼働環境の情報で、出品時点では変わりうる。
//   os            … 同上。
//
// ── 導出値を申告値と混ぜないこと ──────────────────────────────────────────
// 導出した値は `derivedFields` に列挙して保存する。UI はこれを見て「申告」と
// 「推定」を区別して表示する。推定値を申告値として見せるのは、このリポジトリが
// 一貫して避けてきた「未確認のものを確認済みに見せる」振る舞いそのものになる。
const { lookupModel } = require('./perf-score');

// vendor → 使える計算 API。ベンダが決まれば一意（OpenCL はどこでも動くが、
// 既定に選ぶと機種固有の最適化経路を捨てることになるので選ばない）。
const VENDOR_API = Object.freeze({
  NVIDIA: 'CUDA',
  AMD: 'ROCm',
  Intel: 'oneAPI',
});

const DEFAULT_ARCH = 'x86_64';

/** 機種名からカタログ TDP(W) を引く。分からなければ null（0 を返さない）。 */
function lookupTdpWatt(...candidates) {
  const hit = lookupModel(...candidates);
  if (!hit || !hit.spec || typeof hit.spec.tdpWatt !== 'number') return null;
  return hit.spec.tdpWatt;
}

/**
 * 出品の入力に、機種から導出できる既定値を埋める。
 * **申告済みの値は決して上書きしない**（出品者の申告が常に優先）。
 * @param {object} input 出品リクエストのボディ
 * @returns {{gpu:object, derivedFields:string[]}}
 */
function applyListingDefaults(input = {}) {
  const gpu = { ...input };
  const derived = [];

  if (!gpu.apiType && VENDOR_API[gpu.vendor]) {
    gpu.apiType = VENDOR_API[gpu.vendor];
    derived.push('apiType');
  }
  if (!gpu.arch) {
    gpu.arch = DEFAULT_ARCH;
    derived.push('arch');
  }
  // 0 や負値は申告として扱わない。フォームの空欄は Number('') === 0 になりうるが、
  // 「消費電力 0W」は物理的にありえず、排出量推定を 0（＝最も低炭素）に見せてしまう。
  if (typeof gpu.powerWatt !== 'number' || !Number.isFinite(gpu.powerWatt) || gpu.powerWatt <= 0) {
    const tdp = lookupTdpWatt(gpu.model, gpu.name);
    if (tdp != null) {
      gpu.powerWatt = tdp;
      derived.push('powerWatt');
    } else {
      // 参照表に無い機種は**推測しない**。null のままにして、消費電力に依存する
      // 計算（排出量推定・TFLOPS/W 上限）が「不明」として扱えるようにする。
      delete gpu.powerWatt;
    }
  }

  return { gpu, derivedFields: derived };
}

module.exports = { applyListingDefaults, lookupTdpWatt, VENDOR_API, DEFAULT_ARCH };
