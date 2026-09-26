// dlperf-score.js — GPU 機種の標準スコア（Vast.ai DLPerf 相当の正規化指標）。
// docs/improvement-research-2026.md §12「標準ベンチマーク・ホスト信頼性スコア」。
// 借り手が「どの GPU が速いか」を機種横断で比較できるよう、
// プロバイダの自己申告 performance.benchmarkScore とは別に、
// 機種名から参照テーブルを引く server-side スコアを提供する。
//
// スコア定義: score = sqrt(fp16TensorTFLOPS × memBandwidthGBs) / sqrt(RTX4090 基準値)
// → RTX 4090 = 1.000。FP16 tensor 性能とメモリ帯域の幾何平均を取るのは、
// 深層学習/推論ワークロードが演算・帯域の両方に律速されるため
// （Vast.ai DLPerf も同種の合成指標; こちらは公開仕様値からの再現近似）。
// 仕様値は NVIDIA/AMD の公開データシート値（dense FP16 tensor TFLOPS）。
const REFERENCE_GPUS = [
  // { keys: [マッチ用キー(正規化済)], fp16, bw }
  { keys: ['h100sxm', 'h100nvlsxm', 'h100sxm5'], fp16: 989, bw: 3350, label: 'H100 SXM' },
  { keys: ['h100pcie', 'h100'], fp16: 756, bw: 2000, label: 'H100 PCIe' },
  { keys: ['a10080gb', 'a100sxm80gb', 'a100sxm480gb'], fp16: 312, bw: 2039, label: 'A100 SXM 80GB' },
  { keys: ['a10040gb', 'a100pcie40gb'], fp16: 312, bw: 1555, label: 'A100 PCIe 40GB' },
  { keys: ['a100', 'a100pcie'], fp16: 312, bw: 1555, label: 'A100' },
  { keys: ['a40'], fp16: 149.7, bw: 696, label: 'A40' },
  { keys: ['a30'], fp16: 165, bw: 933, label: 'A30' },
  { keys: ['a10', 'a10g'], fp16: 125, bw: 600, label: 'A10' },
  { keys: ['a6000', 'rtxa6000'], fp16: 154.8, bw: 768, label: 'RTX A6000' },
  { keys: ['a5000', 'rtxa5000'], fp16: 127.8, bw: 768, label: 'RTX A5000' },
  { keys: ['rtx6000ada', '6000ada'], fp16: 182.9, bw: 960, label: 'RTX 6000 Ada' },
  { keys: ['l40s'], fp16: 362, bw: 864, label: 'L40S' },
  { keys: ['l40'], fp16: 181.1, bw: 864, label: 'L40' },
  { keys: ['l4'], fp16: 121, bw: 300, label: 'L4' },
  { keys: ['rtx4090', '4090'], fp16: 165.2, bw: 1008, label: 'RTX 4090' },
  { keys: ['rtx3090ti', '3090ti'], fp16: 80, bw: 1008, label: 'RTX 3090 Ti' },
  { keys: ['rtx3090', '3090'], fp16: 71, bw: 936, label: 'RTX 3090' },
  { keys: ['rtx4080super', '4080super'], fp16: 104, bw: 736, label: 'RTX 4080 SUPER' },
  { keys: ['rtx4080', '4080'], fp16: 97.3, bw: 717, label: 'RTX 4080' },
  { keys: ['rtx4070tisuper', '4070tisuper'], fp16: 88.2, bw: 672, label: 'RTX 4070 Ti SUPER' },
  { keys: ['rtx4070ti', '4070ti'], fp16: 80.1, bw: 504, label: 'RTX 4070 Ti' },
  { keys: ['rtx4070', '4070'], fp16: 58.5, bw: 504, label: 'RTX 4070' },
  { keys: ['rtx3080ti', '3080ti'], fp16: 67, bw: 912, label: 'RTX 3080 Ti' },
  { keys: ['rtx3080', '3080'], fp16: 59.6, bw: 760, label: 'RTX 3080' },
  { keys: ['rtx3070ti', '3070ti'], fp16: 44.4, bw: 608, label: 'RTX 3070 Ti' },
  { keys: ['rtx3070', '3070'], fp16: 40.6, bw: 448, label: 'RTX 3070' },
  { keys: ['rtx3060ti', '3060ti'], fp16: 32.5, bw: 448, label: 'RTX 3060 Ti' },
  { keys: ['rtx3060', '3060'], fp16: 24.9, bw: 360, label: 'RTX 3060' },
  { keys: ['rtx4060ti', '4060ti'], fp16: 70.6, bw: 288, label: 'RTX 4060 Ti' },
  { keys: ['rtx4060', '4060'], fp16: 46.6, bw: 272, label: 'RTX 4060' },
  { keys: ['rtx2080ti', '2080ti'], fp16: 53.8, bw: 616, label: 'RTX 2080 Ti' },
  { keys: ['rtx2080', '2080'], fp16: 40, bw: 448, label: 'RTX 2080' },
  { keys: ['gtx1080ti', '1080ti'], fp16: 11.3, bw: 484, label: 'GTX 1080 Ti' },
  { keys: ['v100s', 'v100sxm2'], fp16: 130, bw: 1134, label: 'V100S' },
  { keys: ['v100', 'teslav100'], fp16: 125, bw: 900, label: 'V100' },
  { keys: ['t4', 'teslat4'], fp16: 65, bw: 320, label: 'T4' },
  { keys: ['p100', 'teslap100'], fp16: 21.2, bw: 732, label: 'P100' },
  { keys: ['p4', 'teslap4'], fp16: 5.5, bw: 192, label: 'P4' },
  { keys: ['k80', 'teslak80'], fp16: 8.74, bw: 480, label: 'K80' },
  { keys: ['mi250x', 'mi250'], fp16: 362.1, bw: 3277, label: 'MI250' },
  { keys: ['mi210', 'mi210x'], fp16: 181, bw: 1638, label: 'MI210' },
  { keys: ['mi100'], fp16: 184.6, bw: 1228, label: 'MI100' },
  { keys: ['mi50', 'radeonmi50'], fp16: 26.5, bw: 1024, label: 'MI50' },
  { keys: ['rx7900xtx', '7900xtx'], fp16: 122.8, bw: 960, label: 'RX 7900 XTX' },
];

// RTX 4090 を 1.000 に正規化する基準値
const _REF = Math.sqrt(165.2 * 1008);

const VENDOR_TOKENS = /\b(nvidia|geforce|amd|radeon|tesla)\b/g;

/** 機種文字列を小文字・ベンダー名除去・非英数除去で正規化（"NVIDIA GeForce RTX 4090" → "rtx4090"）。 */
function normalizeModelKey(model) {
  if (typeof model !== 'string') return '';
  return model
    .toLowerCase()
    .replace(VENDOR_TOKENS, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * GPU レコード（model/name フィールド）から標準スコアを解決する。
 * @returns {{score:number|null, matchedModel:string|null, source:'reference-table'|null}}
 *   テーブル未収録の機種は score:null（自己申告値への fallback はしない — 偽装可能なため）。
 */
function standardScore(gpu) {
  const candidates = [gpu && gpu.model, gpu && gpu.name].filter((s) => typeof s === 'string' && s.trim());
  for (const raw of candidates) {
    const key = normalizeModelKey(raw);
    if (!key) continue;
    // 1. exact match
    let hit = REFERENCE_GPUS.find((r) => r.keys.includes(key));
    // 2. substring match（長いキー優先で誤マッチを抑止: "rtx4090" in "nvidia rtx 4090 oc"）
    if (!hit) {
      hit = REFERENCE_GPUS
        .filter((r) => r.keys.some((k) => key.includes(k)))
        .sort((a, b) => Math.max(...b.keys.map((k) => k.length)) - Math.max(...a.keys.map((k) => k.length)))[0];
    }
    if (hit) {
      return {
        score: Math.round((Math.sqrt(hit.fp16 * hit.bw) / _REF) * 1000) / 1000,
        matchedModel: hit.label,
        source: 'reference-table',
      };
    }
  }
  return { score: null, matchedModel: null, source: null };
}

/** GPU レスポンスに載せるフィールド（未知機種は null）。 */
function standardScoreFields(gpu) {
  const s = standardScore(gpu);
  return {
    standardScore: s.score,
    standardScoreModel: s.matchedModel,
  };
}

module.exports = { standardScore, standardScoreFields, normalizeModelKey, REFERENCE_GPUS };
