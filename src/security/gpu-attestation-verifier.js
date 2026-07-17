// src/security/gpu-attestation-verifier.js
// GPU アテステーション検証層（docs/SPECIFICATION.md F2 §GPU アテステーション）。
// Provider が申告した GPU スペック（claimed）と、デバイスが生成したアテステーション
// レポート（report）を照合し、真正性スコアを返す純関数 + Mock ファクトリ。
// インタフェースは ln-adapter と同じ DI パターン（テストは Mock を注入）。
// 将来の nvtrust/Confidential Computing 実装もこの interface に準拠する。

// 各チェックの重み（合計=13）
// - model_match (3): GPU の型番一致は最重要（金銭的詐称の主手段）
// - vendor_match (2): ベンダー一致
// - memory_match (2): メモリ容量一致（価格決定の主要因）
// - firmware_integrity (2): ファームウェア改ざん検知
// - cert_chain (1): 証明書チェーン存在確認
// - freshness (1): レポートが新鮮（リプレイ攻撃防止）
// - signature_present (1): 署名存在（形式）
// - measurements_sane (1): センサー値が物理的に妥当な範囲内

const DEFAULTS = {
  memoryTolerancePct: 5,   // ±5% 以内の誤差は許容（VRAM 容量の表示差異）
  maxAgeSec: 3600,          // レポート有効期限 1 時間
  minScore: 0.6,            // 合格スコア下限（0〜1）
};

/** checks 配列から重み付きスコアを算出。 */
function scoreChecks(checks) {
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const achieved = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  return totalWeight > 0 ? achieved / totalWeight : 0;
}

/**
 * 申告 GPU スペック（claimed）とアテステーションレポート（report）を照合する純関数。
 * @param {object} claimed  Provider が申告したスペック（model, vendor, memoryGB, driverVersion）
 * @param {object} report   デバイスが生成したレポート
 *   { model, vendor, memoryGB, driverVersion, firmwareIntegrity, certChain,
 *     timestamp, signature, measurements: { tempC, powerW, utilizationPct } }
 * @param {object} opts     上書きオプション（memoryTolerancePct, maxAgeSec, minScore）
 * @returns {Promise<{passed:boolean, score:number, findings:string[], checks:Array}>}
 */
async function verifyAttestation(claimed, report, opts = {}) {
  const {
    memoryTolerancePct = DEFAULTS.memoryTolerancePct,
    maxAgeSec = DEFAULTS.maxAgeSec,
    minScore = DEFAULTS.minScore,
  } = opts;

  const findings = [];
  const checks = [];

  // 1. モデル一致（必須条件）
  const claimedModel = (claimed.model || '').toLowerCase().trim();
  const reportModel = (report.model || '').toLowerCase().trim();
  const modelMatch = claimedModel.length > 0 && reportModel.length > 0 && claimedModel === reportModel;
  checks.push({ name: 'model_match', passed: modelMatch, weight: 3 });
  if (!modelMatch) findings.push(`model mismatch: claimed="${claimed.model}", attested="${report.model}"`);

  // 2. ベンダー一致（部分一致許容 — "NVIDIA" vs "NVIDIA Corporation"）
  const vendorOk =
    !report.vendor ||
    !claimed.vendor ||
    report.vendor.toLowerCase().includes(claimed.vendor.toLowerCase()) ||
    claimed.vendor.toLowerCase().includes(report.vendor.toLowerCase());
  checks.push({ name: 'vendor_match', passed: vendorOk, weight: 2 });
  if (!vendorOk) findings.push(`vendor mismatch: claimed="${claimed.vendor}", attested="${report.vendor}"`);

  // 3. メモリ容量（許容誤差内）
  let memoryOk = true;
  if (typeof report.memoryGB === 'number' && typeof claimed.memoryGB === 'number') {
    const pct = Math.abs(report.memoryGB - claimed.memoryGB) / claimed.memoryGB * 100;
    memoryOk = pct <= memoryTolerancePct;
    if (!memoryOk) {
      findings.push(
        `memory mismatch: claimed=${claimed.memoryGB}GB, attested=${report.memoryGB}GB (${pct.toFixed(1)}% diff)`,
      );
    }
  }
  checks.push({ name: 'memory_match', passed: memoryOk, weight: 2 });

  // 4. ファームウェア整合性フラグ
  const firmwareOk = report.firmwareIntegrity === true;
  checks.push({ name: 'firmware_integrity', passed: firmwareOk, weight: 2 });
  if (!firmwareOk) findings.push('firmware integrity check failed or not reported');

  // 5. 証明書チェーン存在
  const certOk = Array.isArray(report.certChain) && report.certChain.length > 0;
  checks.push({ name: 'cert_chain', passed: certOk, weight: 1 });
  if (!certOk) findings.push('certificate chain missing or empty');

  // 6. レポート新鮮性（リプレイ攻撃防止）
  let freshOk = true;
  if (report.timestamp) {
    const ageMs = Date.now() - new Date(report.timestamp).getTime();
    freshOk = ageMs >= 0 && ageMs <= maxAgeSec * 1000;
    if (!freshOk) {
      const ageSec = Math.round(ageMs / 1000);
      findings.push(`report too old: age=${ageSec}s exceeds maxAgeSec=${maxAgeSec}s`);
    }
  }
  checks.push({ name: 'freshness', passed: freshOk, weight: 1 });

  // 7. 署名存在（形式チェック）
  const sigOk = typeof report.signature === 'string' && report.signature.length >= 8;
  checks.push({ name: 'signature_present', passed: sigOk, weight: 1 });
  if (!sigOk) findings.push('report signature missing or too short');

  // 8. センサー計測値の物理的妥当性
  let measOk = true;
  if (report.measurements) {
    const m = report.measurements;
    if (typeof m.tempC === 'number' && (m.tempC < 0 || m.tempC > 120)) {
      measOk = false;
      findings.push(`temperature out of range: ${m.tempC}°C (expected 0–120)`);
    }
    if (typeof m.powerW === 'number' && (m.powerW < 0 || m.powerW > 1000)) {
      measOk = false;
      findings.push(`power draw out of range: ${m.powerW}W (expected 0–1000)`);
    }
    if (typeof m.utilizationPct === 'number' && (m.utilizationPct < 0 || m.utilizationPct > 100)) {
      measOk = false;
      findings.push(`utilization out of range: ${m.utilizationPct}% (expected 0–100)`);
    }
  }
  checks.push({ name: 'measurements_sane', passed: measOk, weight: 1 });

  const score = scoreChecks(checks);
  // 必須チェック群 — いずれか一つでも偽なら score に関係なく失敗。
  //   model_match    : 型番詐称は最重大（価格・用途詐称）
  //   memory_match   : メモリ容量は価格決定の主要因
  //   firmware_integrity : ファームウェア改ざんは実行環境の信頼性を破壊
  //   freshness      : 古いレポートはリプレイ攻撃に悪用可能
  const mandatoryPassed = modelMatch && memoryOk && firmwareOk && freshOk;
  const passed = mandatoryPassed && score >= minScore;

  return { passed, score, findings, checks };
}

/**
 * Mock アテステーション検証器。
 * createMockAttestationVerifier() で取得し、テストや GPU 登録時の開発用途に使う。
 * @param {object} overrides verifyAttestation に渡す opts の上書き
 */
function createMockAttestationVerifier(overrides = {}) {
  const calls = [];

  return {
    /** 呼び出し履歴（テスト検証用）。 */
    calls,

    /** verify — 実 verifier と同じシグネチャ。 */
    async verify(claimed, report, opts = {}) {
      calls.push({ claimed, report });
      return verifyAttestation(claimed, report, { ...overrides, ...opts });
    },

    /**
     * テスト用の正規レポートを生成する。
     * tampered=true: モデル改ざん + 証明書消去 + 署名短縮 + firmwareIntegrity=false
     * stale=true:    タイムスタンプを 2 時間前にする
     */
    buildReport(gpuInfo, { tampered = false, stale = false } = {}) {
      const sig = `mock-sig-${Buffer.from(gpuInfo.model || 'gpu').toString('base64').slice(0, 24)}`;
      return {
        model: tampered ? 'TAMPERED-X9000' : gpuInfo.model,
        vendor: gpuInfo.vendor,
        memoryGB: gpuInfo.memoryGB,
        driverVersion: gpuInfo.driverVersion || '535.0',
        firmwareIntegrity: !tampered,
        certChain: tampered ? [] : ['MOCK-CERT-LEAF', 'MOCK-CERT-INTERMEDIATE', 'MOCK-CERT-ROOT'],
        timestamp: stale
          ? new Date(Date.now() - 7_200_000).toISOString()
          : new Date().toISOString(),
        signature: tampered ? 'XX' : sig,
        measurements: { tempC: 45, powerW: 200, utilizationPct: 5 },
      };
    },
  };
}

module.exports = { verifyAttestation, createMockAttestationVerifier, DEFAULTS, scoreChecks };
