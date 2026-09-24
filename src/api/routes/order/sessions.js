// src/api/routes/order/sessions.js - 利用時間セッション管理
// order ルート群が共有する in-memory セッション状態（usageSessions /
// heartbeatTimestamps）と、タイムアウト監視・SLA スイープの駆動ロジック。
// HTTP ハンドラ（index.js）はこのモジュールの状態を操作する。

const { logger } = require('../../../utils/logger');
const { vgpuManager } = require('../../../core/services');
const OrderRepository = require('../../../db/json/OrderRepository');
const EscrowRepository = require('../../../db/json/EscrowRepository');
const { escrowService } = require('./escrow');
const providerUptime = require('../../../reputation/provider-uptime');
const { notifyUser } = require('../../../utils/user-notify');

const usageSessions = new Map(); // orderId -> OrderUsageSession
// ハートビート頻度制限用の最終受信タイムスタンプ（"orderId:userId" → ms）
const heartbeatTimestamps = new Map();
class OrderUsageSession {
  constructor(orderId, lenderId, renterId) {
    this.orderId = orderId;
    this.lenderId = lenderId;
    this.renterId = renterId;
    this.lenderActive = false;
    this.renterActive = false;
    this.usageStart = null;
    this.accumulatedSeconds = 0;
    this.lastLenderHeartbeat = null;
    this.lastRenterHeartbeat = null;
    this.HEARTBEAT_TIMEOUT = 20 * 1000; // 20秒
  }
  onHeartbeat(userId, role) {
    const now = Date.now();
    if (role === 'lender') {
      this.lenderActive = true;
      this.lastLenderHeartbeat = now;
    } else if (role === 'renter') {
      this.renterActive = true;
      this.lastRenterHeartbeat = now;
    }
    this.updateTimer();
  }
  updateTimer() {
    const now = Date.now();
    if (this.lenderActive && this.renterActive) {
      if (!this.usageStart) this.usageStart = now;
    } else {
      if (this.usageStart) {
        this.accumulatedSeconds += Math.floor((now - this.usageStart) / 1000);
        this.usageStart = null;
      }
    }
  }
  checkTimeouts() {
    const now = Date.now();
    if (this.lastLenderHeartbeat && now - this.lastLenderHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.lenderActive = false;
      this.updateTimer();
    }
    if (this.lastRenterHeartbeat && now - this.lastRenterHeartbeat > this.HEARTBEAT_TIMEOUT) {
      this.renterActive = false;
      this.updateTimer();
    }
  }
  getUsageSeconds() {
    let total = this.accumulatedSeconds;
    if (this.usageStart) {
      total += Math.floor((Date.now() - this.usageStart) / 1000);
    }
    return total;
  }
}

// 全セッションのタイムアウト監視 + 終了済みセッションの回収。
// メモリリーク防止: /stop 以外の終端経路（delete/reject/dispute-resolve）や、
// オーダーが削除済みの孤児セッションをここで一括回収する。これがないと、
// 明示的 /stop を経ずに終了したオーダーのセッションが永久に Map に残る。
const TERMINAL_SESSION_STATUSES = new Set(['completed', 'cancelled']);
function _deleteHeartbeatsForOrder(orderId) {
  // heartbeatTimestamps のキーは `${orderId}:${userId}` 形式。
  const prefix = `${orderId}:`;
  for (const key of heartbeatTimestamps.keys()) {
    if (key.startsWith(prefix)) heartbeatTimestamps.delete(key);
  }
}

function reapUsageSessions() {
  for (const [orderId, session] of usageSessions) {
    session.checkTimeouts();
    let order = null;
    try { order = OrderRepository.getById(orderId); } catch (_) { order = null; }
    if (!order || TERMINAL_SESSION_STATUSES.has(order.status)) {
      usageSessions.delete(orderId);
      _deleteHeartbeatsForOrder(orderId);
    }
  }
}

// --- SLA 違反スイープ（プロバイダーのハートビート途絶＝実質ダウンの自動処理）---
// なぜ必要か: レンタル中に「箱が落ちた」場合、これまでは最大レンタル時間の
// タイムアウト（数時間後）まで何も起きず、借り手は死んだ GPU に対して満額を
// 支払い続けかねなかった。DePIN 市場で企業導入の最大障壁は「強制力のある SLA の
// 不在」（Messari State of DePIN 2025）。ここではプロバイダーのハートビートが
// SLA 猶予を超えて途絶した active 注文を検知し、実提供分だけ按分課金して残りを
// 借り手へ返金し、プロバイダーの信頼性を減点する（TensorDock 型の稼働ペナルティ）。
//
// 安全側の設計:
//  - 「プロバイダーのハートビートが一度届いた後に途絶した」場合のみ発火する
//    （lastLenderHeartbeat が truthy）。一度も届いていない注文は、箱が落ちたのか
//    エージェント未導入なのか判別できないため触らず、既存の最大時間タイムアウトに委ねる。
//  - 按分は実利用秒（session.getUsageSeconds()）ベース。プロバイダー起因の障害では
//    セットアップ最低料金（minChargeRatio）を 0 に上書きし、借り手に不当な床料金を課さない。
//  - 金銭移動（エスクロー精算）は best-effort。失敗しても注文の終端遷移は行う。
const SLA_PROVIDER_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.SLA_PROVIDER_HEARTBEAT_TIMEOUT_MS) || 5 * 60 * 1000,
);
function sweepHeartbeatSlaBreaches(nowMs = Date.now()) {
  const breached = [];
  for (const [orderId, session] of usageSessions) {
    // 証拠主義: プロバイダーのハートビートが一度も無いセッションは対象外。
    if (!session.lastLenderHeartbeat) continue;
    if (nowMs - session.lastLenderHeartbeat <= SLA_PROVIDER_TIMEOUT_MS) continue;

    let order = null;
    try { order = OrderRepository.getById(orderId); } catch (_) { order = null; }
    if (!order || order.status !== 'active') continue;

    const usageSeconds = typeof session.getUsageSeconds === 'function' ? session.getUsageSeconds() : 0;
    const totalSeconds = (Number(order.durationMinutes) || 0) * 60;
    const deliveredRatio = totalSeconds > 0
      ? Math.max(0, Math.min(1, usageSeconds / totalSeconds))
      : 0;

    // active → completed（SLA 違反フラグ付き）。CAS で二重処理を防ぐ。
    const nowIso = new Date(nowMs).toISOString();
    const result = OrderRepository.updateIf(orderId, (o) => o.status === 'active', {
      status: 'completed',
      completedAt: nowIso,
      stoppedAt: nowIso,
      slaBreach: true,
      slaBreachReason: 'provider_heartbeat_lost',
      deliveredRatio,
      updatedAt: nowIso,
    });
    if (!result.ok) continue;

    // GPU 解放（best-effort・非同期）。releaseGPU は Promise を返し reject し得るため、
    // 同期 try/catch では捕捉できない（unhandledRejection でプロセスが落ちる）。
    // fire-and-forget で reject を握り潰す。
    if (vgpuManager) {
      try { Promise.resolve(vgpuManager.releaseGPU(order.gpuId, orderId)).catch(() => {}); } catch (_) {}
    }

    // エスクロー按分精算（プロバイダー起因 → 最低料金床なし）。best-effort。
    try {
      const escrowSvc = escrowService();
      const escrows = EscrowRepository.getByOrderId(orderId).filter(e => e.state === 'HELD');
      for (const escrow of escrows) {
        escrowSvc.settle(escrow.id, { deliveredRatio, slaUptimePct: Math.round(deliveredRatio * 100) }, { minChargeRatio: 0 });
        escrowSvc.apply(escrow.id, 'DELIVER_OK');
      }
    } catch (e) {
      logger.warn(`[sla-sweep] escrow settle failed for order ${orderId}: ${e.message}`);
    }

    // プロバイダー信頼性の減点: 稼働スコアへ SLA 違反、ジョブ成否へ失敗を記録。
    if (order.providerId) {
      try { providerUptime.recordSlaBreach(order.providerId, nowMs); } catch (_) {}
    }

    // 両者へ通知（best-effort）。
    try {
      const pct = Math.round(deliveredRatio * 100);
      if (order.userId) {
        notifyUser(order.userId, 'order_sla_breach',
          `【Strawberry】提供元GPUの応答が途絶したため注文を自動終了しました\n注文: #${orderId}\n実提供 ${pct}% 分のみ課金し、残りは返金対象です。`, {});
      }
      if (order.providerId) {
        notifyUser(order.providerId, 'order_sla_breach',
          `【Strawberry】ハートビート途絶により注文 #${orderId} が自動終了しました。稼働信頼性スコアに影響します。`, {});
      }
    } catch (_) {}

    usageSessions.delete(orderId);
    _deleteHeartbeatsForOrder(orderId);
    breached.push({ id: orderId, deliveredRatio });
    logger.info(`[sla-sweep] order ${orderId} auto-terminated (provider heartbeat lost), deliveredRatio=${deliveredRatio.toFixed(3)}`);
  }
  return breached;
}

// unref: テスト等でプロセス終了を妨げない（server.js の metricsInterval と同方針）
// NODE_ENV==='test' では起動しない。unref だけではタイマーの「蓄積」は防げず、
// このモジュールを require するテストファイルごとに 30 秒周期のスイープが
// 積み上がってイベントループを圧迫する。sweep/reap 関数はテストから直接
// 呼び出して検証されている（tests 内 reapUsageSessions 参照）。
const sessionTimeoutInterval = process.env.NODE_ENV === 'test' ? null : setInterval(() => {
  try {
    sweepHeartbeatSlaBreaches();
    reapUsageSessions();
  } catch (_) { /* jest teardown 後の発火等: 無視 */ }
}, 30000);
if (sessionTimeoutInterval && sessionTimeoutInterval.unref) sessionTimeoutInterval.unref();

function stopSessionSweep() {
  if (sessionTimeoutInterval) clearInterval(sessionTimeoutInterval);
}

module.exports = {
  usageSessions,
  heartbeatTimestamps,
  OrderUsageSession,
  reapUsageSessions,
  sweepHeartbeatSlaBreaches,
  _deleteHeartbeatsForOrder,
  stopSessionSweep,
};
