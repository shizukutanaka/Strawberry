// src/reputation/trust-summary.js — 取引相手の信頼度サマリ（貸し手向け・借り手向け）
//
// 借り手が GPU 詳細で見る「この出品者は信頼できるか」と、貸し手が注文詳細で見る
// 「この借り手は信頼できるか」を、それぞれ一つの関数で出す。
//
// 以前は `GET /users/:id/reputation` と `GET /users/:id/renter-profile` という独立した
// ルートだったが、製品はユーザー ID を画面に出さない（列挙攻撃を避けるため）ので、
// UI がその ID でルートを叩く経路が存在しなかった。ID を知っている場所 — GPU 詳細
// （providerId を持つ）と注文詳細（userId を持つ）— のレスポンスに埋め込む形に変え、
// 独立ルートは削除した。
//
// 同時に、注文詳細が独自に持っていた借り手評価の計算（無効な評価値を 1 に丸めて
// 平均に混ぜる — probe74 が renter-profile 側で直した同じバグ）をここに統一した。
// 計算が 2 箇所にあると片方だけ直る。
const UserRepository = require('../db/json/UserRepository');
const OrderRepository = require('../db/json/OrderRepository');
const { createReputationService } = require('./reputation-service');

// 同一ユーザーへの連続参照で O(n) 集計を繰り返さないための短命キャッシュ。
// テストでは結果が即時に見える必要があるので使わない。
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map(); // key → { data, expiresAt }
function cached(key, compute) {
  if (process.env.NODE_ENV === 'test') return compute();
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = compute();
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

/** レビュー投稿・係争裁定・スラッシュの直後に呼ぶ。 */
function invalidate(userId) {
  if (!userId) return;
  _cache.delete(`provider:${userId}`);
  _cache.delete(`renter:${userId}`);
}

const clamp = (r) => Math.min(5, Math.max(1, r));

/**
 * 評価値の配列を平均する。数値でないもの（undefined・文字列・破損レコード）は
 * **除外**する。1 に丸めて混ぜると、壊れたレコード 1 件が本物の★1 と同じ重さで
 * 平均を引き下げる。範囲外の数値は [1,5] に丸める。
 */
function averageRatings(ratings) {
  const valid = ratings.map(Number).filter(Number.isFinite).map(clamp);
  const reviewCount = valid.length;
  const ratingAverage = reviewCount > 0
    ? Math.round((valid.reduce((s, r) => s + r, 0) / reviewCount) * 10) / 10
    : null;
  return { ratingAverage, reviewCount };
}

/**
 * 同じ相手からの複数レビューは 1 票に潰してから平均する（同一人物が同じ相手に
 * 何度も取引して評価を積み上げる「レビュー爆撃」の重みを落とす）。
 */
function averagePerReviewer(orders, pickReview, fallbackReviewerId) {
  const byReviewer = new Map();
  for (const o of orders) {
    const review = pickReview(o);
    if (!review) continue;
    const r = Number(review.rating);
    if (!Number.isFinite(r)) continue;
    const rid = review.reviewerId || fallbackReviewerId(o);
    const cur = byReviewer.get(rid) || { sum: 0, n: 0 };
    cur.sum += clamp(r); cur.n += 1;
    byReviewer.set(rid, cur);
  }
  return averageRatings(Array.from(byReviewer.values()).map((v) => v.sum / v.n));
}

/**
 * 貸し手の信頼度。GPU 詳細に `providerReputation` として埋め込まれる（公開）。
 * 存在しない・無効化済みユーザーは null。
 */
function providerSummary(providerId) {
  const user = UserRepository.getById(providerId);
  if (!user || user.status === 'deactivated') return null;
  return cached(`provider:${providerId}`, () => {
    const rep = createReputationService();
    const { score, tier, components } = rep.getScore(providerId);
    const stats = rep.getStats(providerId);
    const all = OrderRepository.getAll();
    const asProvider = all.filter((o) => o.providerId === providerId);
    const { ratingAverage, reviewCount } = averagePerReviewer(
      asProvider.filter((o) => o.review), (o) => o.review, (o) => o.userId);
    const asRenter = averagePerReviewer(
      all.filter((o) => o.userId === providerId && o.renterReview), (o) => o.renterReview, (o) => o.providerId);
    return {
      providerId,
      score,
      tier,
      components,
      stats,
      ratingAverage,
      reviewCount,
      completedOrders: asProvider.filter((o) => o.status === 'completed').length,
      rejectedOrders: asProvider.filter((o) => o.cancelReason === 'provider_rejected').length,
      renterRatingAverage: asRenter.ratingAverage,
      renterReviewCount: asRenter.reviewCount,
      memberSince: user.createdAt || null,
    };
  });
}

/**
 * 借り手の信頼度。注文詳細に `renterProfile` として埋め込まれる（当事者にのみ見える）。
 * 存在しない・無効化済みユーザーは null。
 */
function renterSummary(userId) {
  const user = UserRepository.getById(userId);
  if (!user || user.status === 'deactivated') return null;
  return cached(`renter:${userId}`, () => {
    const all = OrderRepository.getAll();
    const reviewed = all.filter((o) => o.userId === userId && o.renterReview);
    const { ratingAverage, reviewCount } = averageRatings(reviewed.map((o) => o.renterReview.rating));
    // 注文 ID は載せない: 貸し手がレビュー本文から他の貸し手との取引を特定できてしまう。
    const recentReviews = reviewed
      .slice()
      .sort((a, b) => (b.renterReview.reviewedAt || '').localeCompare(a.renterReview.reviewedAt || ''))
      .slice(0, 5)
      .map(o => ({ rating: o.renterReview.rating, comment: o.renterReview.comment || null, reviewedAt: o.renterReview.reviewedAt }));
    return {
      userId,
      ratingAverage,
      reviewCount,
      completedOrders: all.filter((o) => o.userId === userId && o.status === 'completed').length,
      recentReviews,
      memberSince: user.createdAt || null,
    };
  });
}

module.exports = { providerSummary, renterSummary, averageRatings, invalidate };
