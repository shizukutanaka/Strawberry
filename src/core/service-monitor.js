// src/core/service-monitor.js - サービス死活監視・自動復旧
const { logger } = require('../utils/logger');
// モジュール参照で保持して呼び出す（destructure で const に束縛するとテストの
// jest.spyOn が効かず、監査記録の検証ができないため）。
const auditLog = require('../utils/audit-log');
const client = require('prom-client');

// Prometheusメトリクス
const serviceRestartCounter = new client.Counter({ name: 'service_restart_total', help: 'Total number of service auto-restarts', labelNames: ['service'] });
const serviceDownCounter = new client.Counter({ name: 'service_down_total', help: 'Total number of detected service downs', labelNames: ['service'] });

// 監視対象サービスの参照を保持
let services = {};
function setServices(refs) {
  services = refs;
}

// 外部通知hook（Slack/Sentry/LINE）。実装は src/utils/external-alerts.js。
//
// 以前はここから scripts/*.js を直接 require していたが、Slack は
// export 名が食い違っていて（sendSlackMessage は export されていなかった）
// **一度も送信できていなかった**。しかも例外は catch されて warn ログに消え、
// 「通知が来ない」ことに誰も気づけない状態だった。
// 通知モジュール側が結果を返すようにし、ここでは**送れたかどうか**をログに出す。
// 設定済みなのに送れなかった場合は error にする — 死んでいる通知経路は、
// 通知経路が無いより悪い（来ないことを異常だと気づけない）。
async function notifyExternalAlert(event, data) {
  try {
    const results = await require('../utils/external-alerts').notifyAll(event, data);
    for (const r of results) {
      if (r.sent) {
        logger.info(`[ExternalAlert] ${r.channel} 通知送信: ${event}`);
      } else {
        logger.error(
          `[ExternalAlert] ${r.channel} は設定されているのに送信できませんでした (${r.reason}): ${event}`
        );
      }
    }
  } catch (e) {
    logger.warn('[ExternalAlert] 通知処理で例外:', e);
  }
  // 外部チャネルの設定有無に関わらず、アラート自体はローカルログに残す（監査・障害追跡）。
  logger.warn(`[ExternalAlert] ${event}:`, data);
}

// 詳細ヘルスチェック
async function isServiceHealthy(name, svc) {
  if (typeof svc.isHealthy === 'function') {
    try {
      return await svc.isHealthy();
    } catch (e) {
      logger.error(`[Monitor] ${name}.isHealthy() threw:`, e);
      return false;
    }
  }
  // fallback: initializedフラグ
  return !!svc.initialized;
}

// サービスの死活監視・自動復旧
async function monitorServices() {
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    try {
      const healthy = await isServiceHealthy(name, svc);
      if (!healthy) {
        logger.error(`[Monitor] ${name} unhealthy. Attempting restart.`);
        auditLog.appendAuditLog('service_down', { service: name });
        serviceDownCounter.inc({ service: name });
        await notifyExternalAlert('service_down', { service: name });
        try {
          if (typeof svc.initialize === 'function') {
            await svc.initialize();
            logger.info(`[Monitor] ${name} restarted successfully.`);
            auditLog.appendAuditLog('service_restart', { service: name });
            serviceRestartCounter.inc({ service: name });
            await notifyExternalAlert('service_restart', { service: name });
          } else if (typeof svc.start === 'function') {
            await svc.start();
            logger.info(`[Monitor] ${name} started successfully.`);
            auditLog.appendAuditLog('service_restart', { service: name });
            serviceRestartCounter.inc({ service: name });
            await notifyExternalAlert('service_restart', { service: name });
          }
        } catch (e) {
          logger.error(`[Monitor] ${name} restart failed:`, e);
          auditLog.appendAuditLog('service_restart_failed', { service: name, error: e.message });
          await notifyExternalAlert('service_restart_failed', { service: name, error: e.message });
        }
      }
    } catch (e) {
      logger.error(`[Monitor] Exception during monitoring ${name}:`, e);
    }
  }
}

// startMonitor() が生成する setInterval のハンドルを保持する。unref() 済みなので
// 単体では本番のプロセス終了を妨げないが、明示的に止める手段が無いと、同一
// Node プロセス内で server.js が繰り返し require される場面（典型的には Jest が
// 多数のテストファイルで `require('../../src/api/server')` する場合。Jest は
// テストファイルごとにモジュールレジストリを分離するため、各ファイルが
// 独自の setInterval を作るが、実タイマー自体は同一プロセスのイベントループに
// 残り続ける）で際限なく積み上がる。`npm test` は `--forceExit` でプロセスごと
// 強制終了するため症状が隠れるが、`--forceExit` なしで `jest` を直接実行すると
// 蓄積したタイマーが 10 秒ごとに発火し続け、audit log が際限なく肥大化し、
// プロセスが実質ハングしたように見える（実際に数時間規模で観測: audit/error
// ログが数百MBまで成長）。stopMonitor() で明示的に止められるようにする。
let _timer = null;

// 10秒ごとに監視
function startMonitor() {
  const interval = parseInt(process.env.SERVICE_MONITOR_INTERVAL_MS, 10) || 10000;
  // unref: テスト等でプロセス終了を妨げない
  _timer = setInterval(monitorServices, interval);
  if (_timer.unref) _timer.unref();
  logger.info(`[Monitor] Service monitor started (interval=${interval}ms)`);
}

function stopMonitor() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  services = {};
}

module.exports = {
  setServices,
  startMonitor,
  stopMonitor,
  monitorServices,
  isServiceHealthy,
  notifyExternalAlert,
  serviceRestartCounter,
  serviceDownCounter,
};
