// GPU貸出/借入監視の自動リカバリ・自己修復ユーティリティ
const { getAll: getOrders, updateStatus: updateOrderStatus } = require('../db/json/OrderRepository');
const { getById: getGPUById } = require('../db/json/GpuRepository');
const { getByOrderId: getPaymentByOrderId, refundPayment } = require('../db/json/PaymentRepository');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');
const { reportAnomaly } = require('./anomaly-detector');

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
      // 異常検知・自動リカバリ
      await updateOrderStatus(order.id, 'auto_recovered');
      await appendAuditLog('gpu_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      await reportAnomaly('gpu_lending_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      // 返金処理（必要に応じて）
      const payment = await getPaymentByOrderId(order.id);
      if (payment && payment.status === 'paid') {
        await refundPayment(payment.id);
        await appendAuditLog('gpu_auto_refund', { paymentId: payment.id, orderId: order.id });
      }
      // 多重通知
      await resilientNotify(`[Strawberry] GPU貸出/借入異常を自動リカバリしました\nOrderID: ${order.id}\nGPU: ${gpu ? gpu.name : order.gpuId}`);
    }
  }
}

function startGpuMonitor() {
  setInterval(monitorAndRecover, CHECK_INTERVAL);
}

module.exports = { startGpuMonitor, monitorAndRecover };
