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

// 外部通知hook（Slack/Sentry/LINE/他サービス拡張）
async function notifyExternalAlert(event, data) {
  // Slack通知（.envにSLACK_WEBHOOK_URLがあれば）
  try {
    const { sendSlackMessage } = require('../../scripts/slack-notify.js');
    if (process.env.SLACK_WEBHOOK_URL) {
      await sendSlackMessage(`[${event}] ${JSON.stringify(data)}`);
      logger.info(`[ExternalAlert] Slack通知送信: ${event}`);
    }
  } catch (e) {
    logger.warn(`[ExternalAlert] Slack通知モジュール呼び出し失敗:`, e);
  }
  // Sentry通知（.envにSENTRY_DSNがあれば）
  try {
    const { sendSentryNotification } = require('../../scripts/sentry-notify.js');
    if (process.env.SENTRY_DSN) {
      await sendSentryNotification(event, data);
      logger.info(`[ExternalAlert] Sentry通知送信: ${event}`);
    }
  } catch (e) {
    logger.warn(`[ExternalAlert] Sentry通知モジュール呼び出し失敗:`, e);
  }
  // LINE通知（.envにLINE_TOKENがあれば）
  try {
    const { sendLineNotification } = require('../../scripts/line-notify.js');
    if (process.env.LINE_TOKEN) {
      await sendLineNotification(event, data);
      logger.info(`[ExternalAlert] LINE通知送信: ${event}`);
    }
  } catch (e) {
    logger.warn(`[ExternalAlert] LINE通知モジュール呼び出し失敗:`, e);
  }
  // いずれも未設定時はloggerのみ
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

// 10秒ごとに監視
function startMonitor() {
  const interval = parseInt(process.env.SERVICE_MONITOR_INTERVAL_MS, 10) || 10000;
  // unref: テスト等でプロセス終了を妨げない
  const timer = setInterval(monitorServices, interval);
  if (timer.unref) timer.unref();
  logger.info(`[Monitor] Service monitor started (interval=${interval}ms)`);
}

module.exports = {
  setServices,
  startMonitor,
  monitorServices,
  isServiceHealthy,
  notifyExternalAlert,
  serviceRestartCounter,
  serviceDownCounter,
};
