// GPU貸出/借入監視の自動リカバリ・自己修復ユーティリティ
const { getAll: getOrders, update: updateOrder } = require('../db/json/OrderRepository');
const { getById: getGPUById } = require('../db/json/GpuRepository');
const PaymentRepository = require('../db/json/PaymentRepository');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');
const { reportAnomaly } = require('./anomaly-detector');
const { logger } = require('./logger');

const CHECK_INTERVAL = 60 * 1000; // 1分ごと

async function monitorAndRecover() {
  const orders = await getOrders();
  const now = Date.now();
  for (const order of orders) {
    if (order.status !== 'active') continue;
    // GPUの死活監視
    const gpu = await getGPUById(order.gpuId);
    let alive = true;
    if (!gpu) alive = false;
    if (gpu && gpu.lastHeartbeat && now - new Date(gpu.lastHeartbeat).getTime() > 2 * 60 * 1000) alive = false; // 2分以上応答なし
    // 追加の健全性チェック（プロセス/エラー/リソース等）もここで拡張可
    if (!alive) {
      // 異常検知・自動リカバリ。状態は ORDER_STATES（state-checker）の有効値である
      // 'cancelled' に落とす — 独自状態は遷移表に存在せず注文が永久に遷移不能になる
      await updateOrder(order.id, { status: 'cancelled' });
      await appendAuditLog('gpu_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      await reportAnomaly('gpu_lending_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      // 返金処理（支払い済みの場合）。getByOrderId は many:true で配列を返す。
      // 実エスクローの解放は cancel/dispute 系の経路（escrow 連携）側の責務 — ここでは
      // gpu-auto-recovery.js と同規約で支払いレコードを refunded へ落とす。
      const payments = await PaymentRepository.getByOrderId(order.id) || [];
      for (const payment of payments) {
        if (payment.status === 'paid') {
          await PaymentRepository.update(payment.id, { status: 'refunded', refundedAt: new Date().toISOString() });
          await appendAuditLog('gpu_auto_refund', { paymentId: payment.id, orderId: order.id });
        }
      }
      // 多重通知
      await resilientNotify(`[Strawberry] GPU貸出/借入異常を自動リカバリしました\nOrderID: ${order.id}\nGPU: ${gpu ? gpu.name : order.gpuId}`);
    }
  }
}

let _monitorTimer = null;
let _monitorInFlight = false;

function startGpuMonitor() {
  if (_monitorTimer) return _monitorTimer; // 多重起動防止
  // monitorAndRecover が 60 秒を超えて走り続けた場合の tick 重なりを防ぐ
  _monitorTimer = setInterval(() => {
    if (_monitorInFlight) return;
    _monitorInFlight = true;
    Promise.resolve(monitorAndRecover())
      .catch(err => logger.error('[gpu-monitor] monitor tick failed:', err))
      .finally(() => { _monitorInFlight = false; });
  }, CHECK_INTERVAL);
  // unref: 監視タイマーがプロセス終了を妨げない
  if (_monitorTimer.unref) _monitorTimer.unref();
  return _monitorTimer;
}

function stopGpuMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}

module.exports = { startGpuMonitor, stopGpuMonitor, monitorAndRecover };
