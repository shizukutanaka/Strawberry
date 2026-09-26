// payment-reminder.js - 支払い未完了ユーザーへの自動リマインダースクリプト
// 支払いがpendingの注文/支払いを定期チェックし、LINE等で自動通知

const path = require('path');
const { sendNotification, NotifyType } = require('./notifier');
const { logger } = require('./logger');

// リポジトリは src/db/json/ 配下。このファイルは src/utils/ にあるため '../db/json/…' が正。
// 元の '../../db/json/…' はリポジトリルート直下の存在しない db/ を指しており、
// このモジュールを require した時点で MODULE_NOT_FOUND となり全機能が死んでいた。
const PaymentRepository = require('../db/json/PaymentRepository');
const OrderRepository = require('../db/json/OrderRepository');
const UserRepository = require('../db/json/UserRepository');

// 送信直後まで猶予を与える（作成直後の支払いはまだ決済中かもしれない）
const REMINDER_MIN_AGE_MS = Math.max(0, Number(process.env.REMINDER_MIN_AGE_MS) || 15 * 60 * 1000);
// 同一支払いへの再送間隔（定期実行でのスパム防止）
const REMINDER_COOLDOWN_MS = Math.max(60_000, Number(process.env.REMINDER_COOLDOWN_MS) || 24 * 60 * 60 * 1000);

// リマインダー対象となる「未払い」状態の支払いを取得。
// - 期限切れインボイスは除く（支払えないものを催促しない）
// - 作成直後は除く（REMINDER_MIN_AGE_MS）
// - 直近送信済みは除く（REMINDER_COOLDOWN_MS、payment.lastRemindedAt で管理）
function getPendingPayments(now = new Date()) {
  const nowMs = now.getTime();
  return PaymentRepository.getAll().filter(p => {
    if (p.status !== 'pending') return false;
    const expiresMs = p.invoiceExpiresAt ? new Date(p.invoiceExpiresAt).getTime() : Infinity;
    if (expiresMs <= nowMs) return false;
    const createdMs = p.createdAt ? new Date(p.createdAt).getTime() : 0;
    if (nowMs - createdMs < REMINDER_MIN_AGE_MS) return false;
    if (p.lastRemindedAt && nowMs - new Date(p.lastRemindedAt).getTime() < REMINDER_COOLDOWN_MS) return false;
    return true;
  });
}

// 対象ユーザーへのリマインド送信。送信成功時のみ lastRemindedAt を記録する。
async function remindPendingPayments({ now = new Date() } = {}) {
  const pendingPayments = getPendingPayments(now);
  let sent = 0;
  for (const payment of pendingPayments) {
    const user = UserRepository.getById(payment.userId);
    if (!user) continue;
    // 通知先（例: LINE）
    if (process.env.LINE_TOKEN && user.notifyByLine !== false) {
      const msg = `【支払いリマインダー】\n未払い注文があります\n注文ID: ${payment.orderId || '-'}\n金額: ${payment.amount} sat\nお早めにお支払いください。`;
      try {
        await sendNotification(NotifyType.LINE, msg, { token: process.env.LINE_TOKEN });
        // 送信成功時のみクールダウン起点を記録（失敗時は次周期で再試行）
        try { PaymentRepository.update(payment.id, { lastRemindedAt: now.toISOString() }); } catch (_) {}
        sent++;
        logger.info('支払いリマインダー送信', { userId: user.id, paymentId: payment.id });
      } catch (err) {
        logger.error('リマインダー送信失敗', { userId: user.id, error: err.message });
      }
    }
    // 他の通知チャネルも拡張可能
  }
  return { candidates: pendingPayments.length, sent };
}

if (require.main === module) {
  remindPendingPayments().then(() => {
    logger.info('全リマインダー送信完了');
    process.exit(0);
  }).catch(err => {
    logger.error('リマインダー送信全体でエラー', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  remindPendingPayments,
  getPendingPayments,
  REMINDER_MIN_AGE_MS,
  REMINDER_COOLDOWN_MS,
};
