// payment-reminder.js - 支払い未完了ユーザーへの自動リマインダースクリプト
// 支払いがpendingの注文/支払いを定期チェックし、LINE等で自動通知

const path = require('path');
const { sendNotification, NotifyType } = require('./notifier');
const { logger } = require('./logger');

const PaymentRepository = require('../../db/json/PaymentRepository');
const OrderRepository = require('../../db/json/OrderRepository');
const UserRepository = require('../../db/json/UserRepository');

// リマインダー対象となる「未払い」状態の支払いを取得
function getPendingPayments() {
  return PaymentRepository.getAll().filter(p => p.status === 'pending');
}

// 対象ユーザーへのリマインド送信
async function remindPendingPayments() {
  const pendingPayments = getPendingPayments();
  for (const payment of pendingPayments) {
    const user = UserRepository.getById(payment.userId);
    if (!user) continue;
    // 通知先（例: LINE）
    if (process.env.LINE_TOKEN && user.notifyByLine !== false) {
      const msg = `【支払いリマインダー】\n未払い注文があります\n注文ID: ${payment.orderId || '-'}\n金額: ${payment.amount} sat\nお早めにお支払いください。`;
      try {
        await sendNotification(NotifyType.LINE, msg, { token: process.env.LINE_TOKEN });
        logger.info('支払いリマインダー送信', { userId: user.id, paymentId: payment.id });
      } catch (err) {
        logger.error('リマインダー送信失敗', { userId: user.id, error: err.message });
      }
    }
    // 他の通知チャネルも拡張可能
  }
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
};
