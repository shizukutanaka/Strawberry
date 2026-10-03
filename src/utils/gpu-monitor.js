// GPU貸出/借入監視の自動リカバリ・自己修復ユーティリティ
const { getAll: getOrders, update: updateOrder } = require('../db/json/OrderRepository');
const { getById: getGPUById } = require('../db/json/GpuRepository');
const PaymentRepository = require('../db/json/PaymentRepository');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');
const { reportAnomaly } = require('./anomaly-detector');
const { logger } = require('./logger');

// GPU_MONITOR_INTERVAL_MS の解釈。0/未設定/不正値は「無効」を返す。
// 自動リカバリは注文取消・返金マークを伴うため既定では無効（opt-in 起動）。
function resolveIntervalMs(env) {
  const raw = env.GPU_MONITOR_INTERVAL_MS;
  if (raw === undefined || raw === null || raw === '') return 0;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    logger.warn(`gpu-monitor: invalid GPU_MONITOR_INTERVAL_MS="${raw}" — disabled`);
    return 0;
  }
  return Math.round(ms);
}

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

// 定期監視を開始する。返り値はタイマー（無効時は null）。
// options:
//   intervalMs   — 直接指定（省略時は GPU_MONITOR_INTERVAL_MS から解決）
//   allowInTest  — NODE_ENV=test でも起動を許可（テスト用）
function startGpuMonitor(options = {}) {
  const intervalMs = options.intervalMs !== undefined
    ? options.intervalMs
    : resolveIntervalMs(process.env);
  if (intervalMs <= 0) return null;
  if (process.env.NODE_ENV === 'test' && !options.allowInTest) return null;
  if (_monitorTimer) return _monitorTimer; // 多重起動防止
  // monitorAndRecover が 60 秒を超えて走り続けた場合の tick 重なりを防ぐ
  _monitorTimer = setInterval(() => {
    if (_monitorInFlight) return;
    _monitorInFlight = true;
    Promise.resolve(monitorAndRecover())
      .catch(err => logger.error('[gpu-monitor] monitor tick failed:', err))
      .finally(() => { _monitorInFlight = false; });
  }, intervalMs);
  // unref: 監視タイマーがプロセス終了を妨げない
  if (_monitorTimer.unref) _monitorTimer.unref();
  logger.info(`gpu-monitor: started (every ${Math.round(intervalMs / 1000)}s)`);
  return _monitorTimer;
}

function stopGpuMonitor() {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}

module.exports = { startGpuMonitor, stopGpuMonitor, monitorAndRecover, resolveIntervalMs };
