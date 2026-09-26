// src/marketplace/marketplace-service.js
// マーケットプレイス合成サービス（docs/SPECIFICATION.md §6-2 配線の中核）。
// 価格(feature-pricer)・レピュテーション・検証・エスクローの各サービスを束ね、
// 高レベルのドメインフローに合成する。HTTP ルートハンドラはこのサービスを呼ぶ薄い
// ラッパとして実装すればよい（ルート直書きを避け、テスト可能性を確保）。
// 各サブサービスは DI（テストはインメモリ repo を注入）。
const crypto = require('crypto');
const featurePricer = require('../pricing/feature-pricer');
const { runAuction } = require('./auction-engine');
const { detectShills } = require('./shill-detector');
const { appendAuditLog } = require('../utils/audit-log');
const { logger } = require('../utils/logger');

function createMarketplaceService({
  escrowService,
  verificationService,
  reputationService,
  pricer = featurePricer,
  pricingOpts = {},
  bidRepository = null,
  shillOpts = {},
} = {}) {
  if (!escrowService || !verificationService || !reputationService) {
    throw new Error('escrowService, verificationService, reputationService are required');
  }
  // 入札履歴の永続化（談合検出の入力）。省略時は既定 JSON リポジトリを遅延解決し、
  // テストではインメモリ fake を注入できる。
  const bidRepo = bidRepository || require('../db/json/BidRepository');

  /** GPU 特徴量＋需給から時給を見積もる。 */
  function quoteGpu(gpu, market = {}) {
    return pricer.computePrice(gpu, market, pricingOpts);
  }

  /** 候補プロバイダをレピュテーション順に並べる（マッチング）。 */
  function rankCandidates(providerIds, opts = {}) {
    return reputationService.rank(providerIds, opts);
  }

  /**
   * 逆オークションでプロバイダを選定する（Akash/Golem 型マッチング）。
   * 各 bid のレピュテーションは reputationService から自動補完する（bid に
   * reputationScore があればそれを優先）。価格・レピュテーション・SLA・
   * アテステーションを統合した効用スコアで勝者を選ぶ。
   *
   * 談合検出（docs/improvement-research-2026.md §17）:
   *  - 全入札を BidRepository に記録し、履歴横断で shill-detector を走らせる。
   *  - 検出結果は { auctionId, flagged, suspicions } として結果に付随し、
   *    flagged 参加者は ranked 行に suspicion が付記される。
   *  - 既定は報告のみ（オークション結果を変えない・誤検知で正直者を焼かない）。
   *    auctionOpts.excludeFlagged === true で事前 flag 済み入札者を eligible=false に、
   *    auctionOpts.enforceShillSlash === true で検出済み参加者に reputation slash
   *    （arXiv:2506.00282 の動的ペナルティ）を適用する。
   * @param {Array<object>} bids { providerId, pricePerHour, slaUptimePct?, attestationScore?, attestationPassed? }
   * @param {object} auctionOpts auction-engine の opts（reservePrice/minReputation/weights 等）
   *   ＋ excludeFlagged / enforceShillSlash
   * @returns {{winner, ranked, rejected, auctionId, flagged, suspicions}}
   */
  function selectProvider(bids, auctionOpts = {}) {
    if (!Array.isArray(bids)) throw new Error('bids must be an array');
    const enriched = bids.map((b) => {
      if (typeof b.reputationScore === 'number') return b;
      const rep = b.providerId ? reputationService.getScore(b.providerId) : { score: 0 };
      return { ...b, reputationScore: rep.score };
    });

    // 事前検知: 既に flag 済みの入札者を除外するのは excludeFlagged 指定時のみ。
    // 検出系の障害（履歴破損等）でオークション自体を落とさないため全段 try/catch。
    let priorFlagged = [];
    try {
      priorFlagged = detectShills(readBidHistory(), shillOpts).flagged;
    } catch (e) {
      logger.warn(`[auction] shill pre-detection failed: ${e.message}`);
    }
    const effective =
      auctionOpts.excludeFlagged === true && priorFlagged.length > 0
        ? enriched.map((b) => (priorFlagged.includes(String(b.providerId)) ? { ...b, eligible: false } : b))
        : enriched;

    const result = runAuction(effective, auctionOpts);
    const auctionId = crypto.randomUUID();
    recordBids(auctionId, enriched, result);

    let detection = { flagged: [], suspicions: [], pairs: [] };
    try {
      detection = detectShills(readBidHistory(), shillOpts);
    } catch (e) {
      logger.warn(`[auction] shill detection failed: ${e.message}`);
    }

    if (detection.flagged.length > 0) {
      // 動的ペナルティ（明示 opt-in）: 検出済みプロバイダを reputation で slash
      if (auctionOpts.enforceShillSlash === true) {
        for (const pid of detection.flagged) {
          try {
            reputationService.slash(pid);
          } catch (e) {
            logger.warn(`[auction] reputation slash failed for ${pid}: ${e.message}`);
          }
        }
      }
      try {
        appendAuditLog('auction_collusion_suspected', {
          auctionId,
          flagged: detection.flagged,
          pairs: detection.pairs,
        });
        require('../utils/anomaly-detector').reportAnomaly('auction_collusion_suspected', {
          auctionId,
          flagged: detection.flagged,
        });
      } catch (e) {
        logger.warn(`[auction] collusion alert failed: ${e.message}`);
      }
    }

    // 応答の ranked 行に疑念スコアを付記（呼び出し側が理由を確認できるように）
    const suspByProvider = new Map(detection.suspicions.map((x) => [x.providerId, x]));
    const ranked = result.ranked.map((r) => {
      const s = suspByProvider.get(String(r.providerId));
      return s ? { ...r, suspicion: { score: s.score, flagged: s.flagged, signals: s.signals.map((x) => x.type) } } : r;
    });

    return { ...result, ranked, auctionId, flagged: detection.flagged, suspicions: detection.suspicions };
  }

  /** BidRepository の履歴を新しい順に最大 historyLimit 件読む（検出入力の上限）。 */
  function readBidHistory() {
    const rows = bidRepo.getAll();
    const limit = shillOpts.historyLimit || 5000;
    return rows.length > limit ? rows.slice(rows.length - limit) : rows;
  }

  /** 今回のオークションの入札を履歴に記録する。記録失敗は結果をマスクしない。 */
  function recordBids(auctionId, bids, result) {
    const winnerId = result.winner ? String(result.winner.providerId) : null;
    const eligibleIds = new Set(result.ranked.map((r) => String(r.providerId)));
    const at = new Date().toISOString();
    for (const b of bids) {
      if (!b || b.providerId === undefined || b.providerId === null) continue;
      try {
        bidRepo.create({
          auctionId,
          providerId: String(b.providerId),
          pricePerHour: Number.isFinite(b.pricePerHour) ? b.pricePerHour : null,
          won: winnerId !== null && String(b.providerId) === winnerId,
          eligible: eligibleIds.has(String(b.providerId)),
          createdAt: at,
        });
      } catch (e) {
        logger.warn(`[auction] failed to record bid: ${e.message}`);
      }
    }
  }

  /** 蓄積済み入札履歴の談合検出結果を返す（運用者向け read-only）。 */
  function getAuctionSuspicions() {
    return detectShills(readBidHistory(), shillOpts);
  }

  /**
   * 注文に対し価格を確定し、hold-invoice エスクローを開く（PENDING）。
   * @returns {{escrow, quote, amountSats, providerId}}
   */
  function openOrderEscrow({ orderId, providerId = null, gpu = {}, durationMinutes = 0, market = {}, feeRate = 0, amountSatOverride }) {
    if (!orderId) throw new Error('orderId required');
    const quote = quoteGpu(gpu, market);
    const hours = Math.max(0, durationMinutes) / 60;
    // amountSatOverride: HTTP ルートが注文の price-locked totalPrice を渡す。
    // 渡されない場合（ユニットテスト・直接呼び出し）は quote から計算する。
    const amountSats = typeof amountSatOverride === 'number' ? amountSatOverride : Math.round(quote.pricePerHour * hours);
    const escrow = escrowService.create({ orderId, amountSats, feeRate, invoice: null });
    return { escrow, quote, amountSats, providerId };
  }

  /** hold invoice 入金（PENDING→HELD）。 */
  function recordPaid(escrowId) {
    return escrowService.markPaid(escrowId);
  }

  /**
   * ジョブ結果を検証し、エスクローを解放/係争へ進め、レピュテーションを更新する。
   * @returns {{verdict, event, escrow, actions}}
   */
  function verifyAndSettle({ jobId, escrowId, providerId = null, primaryOutput, utilSamples = [], replicas = [], auditRate }) {
    if (!jobId || !escrowId) throw new Error('jobId and escrowId are required');
    verificationService.open(jobId, { providerId, escrowId, auditRate });
    verificationService.recordPrimary(jobId, primaryOutput, { utilSamples });
    for (const r of replicas) verificationService.submitReplica(jobId, r);
    const v = verificationService.finalize(jobId);

    const result = escrowService.evaluate(escrowId, v.verificationCtx);

    if (providerId) {
      if (result.event === 'DELIVER_OK') reputationService.recordJobResult(providerId, true);
      else if (result.event === 'DELIVER_FAIL') reputationService.recordJobResult(providerId, false);
    }
    return { verdict: v.verdict, event: result.event, escrow: result.escrow, actions: result.actions };
  }

  /** 係争の解決（'settle'/'refund'）。refund 時はプロバイダを slash。 */
  function resolveDispute(escrowId, decision, providerId = null) {
    const r = escrowService.resolveDispute(escrowId, decision);
    if (providerId && decision === 'refund') reputationService.slash(providerId);
    return r;
  }

  /**
   * 実使用量・SLA に応じた従量按分の精算内訳を計算・記録する。
   * heartbeat で計測した accumulatedSeconds と予約時間から deliveredRatio を求めて渡す。
   * @returns {{escrow, settlement}}
   */
  function settleByUsage(escrowId, usage = {}, opts = {}) {
    return escrowService.settle(escrowId, usage, opts);
  }

  /** エスクローの現在状態を取得（読み取り）。 */
  function getEscrow(escrowId) {
    return escrowService.get(escrowId);
  }

  return { quoteGpu, rankCandidates, selectProvider, getAuctionSuspicions, openOrderEscrow, recordPaid, verifyAndSettle, settleByUsage, resolveDispute, getEscrow };
}

module.exports = { createMarketplaceService };
