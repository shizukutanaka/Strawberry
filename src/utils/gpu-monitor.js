// GPU貸出/借入監視の自動リカバリ・自己修復ユーティリティ
const { getAll: getOrders, updateIf: updateOrderIf } = require('../db/json/OrderRepository');
const GpuRepository = require('../db/json/GpuRepository');
const PaymentRepository = require('../db/json/PaymentRepository');
const { resilientNotify } = require('./resilient-notify');
const { appendAuditLog } = require('./audit-log');
const { reportAnomaly } = require('./anomaly-detector');
const { logger } = require('./logger');

const CHECK_INTERVAL = 60 * 1000; // 1分ごと

async function monitorAndRecover() {
  const orders = await getOrders();
  // 死活監視の GPU 参照は tick 冒頭で1回だけ読む — 旧実装は order 毎に
  // getGPUById しており、1分毎に active 注文数ぶんの gpus.json 全量パースが走っていた
  const gpuById = new Map(GpuRepository.getAll().map(gpu => [gpu.id, gpu]));
  const now = Date.now();
  for (const order of orders) {
    if (order.status !== 'active') continue;
    // GPUの死活監視
    const gpu = gpuById.get(order.gpuId);
    let alive = true;
    if (!gpu) alive = false;
    if (gpu && gpu.lastHeartbeat && now - new Date(gpu.lastHeartbeat).getTime() > 2 * 60 * 1000) alive = false; // 2分以上応答なし
    // 追加の健全性チェック（プロセス/エラー/リソース等）もここで拡張可
    if (!alive) {
      // 異常検知・自動リカバリ。状態は ORDER_STATES（state-checker）の有効値である
      // 'cancelled' に落とす — 独自状態は遷移表に存在せず注文が永久に遷移不能になる。
      // active 前提の CAS: tick 冒頭の読込以降に利用停止/期限切れ等で終端へ進んだ
      // 注文を cancelled へ回帰させない（CAS 不成立なら回復不要なので処理ごと skip）。
      const writeResult = updateOrderIf(
        order.id,
        (o) => o.status === 'active',
        { status: 'cancelled' }
      );
      if (!writeResult || !writeResult.ok) continue;
      await appendAuditLog('gpu_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      await reportAnomaly('gpu_lending_auto_recover', { orderId: order.id, gpuId: order.gpuId, userId: order.userId });
      // 返金処理（支払い済みの場合）。getByOrderId は many:true で配列を返す。
      // 実エスクローの解放は cancel/dispute 系の経路（escrow 連携）側の責務 — ここでは
      // gpu-auto-recovery.js と同規約で支払いレコードを refunded へ落とす。
      // 返金も paid 前提の CAS: 読込以降に他経路（手動承認/on-chain 等）が状態を
      // 進めた決済を refunded へ上書きしない。
      const payments = await PaymentRepository.getByOrderId(order.id) || [];
      for (const payment of payments) {
        const refundResult = PaymentRepository.updateIf(
          payment.id,
          (p) => p.status === 'paid',
          { status: 'refunded', refundedAt: new Date().toISOString() }
        );
        if (refundResult && refundResult.ok) {
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
