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
  // 監視対象から外れたサービスの通知状態を掃除する（旧 service が再追加される
  // まで古い downSince が残り続けるのを防ぐ）。
  for (const name of _serviceState.keys()) {
    if (!refs[name]) _serviceState.delete(name);
  }
}

// サービスごとの外部通知状態。不健全 tick ごとに service_down / service_restart_failed
// を外部通知していた旧実装は、監視間隔 10 秒 × 障害 1 時間で 1 サービスあたり最大
// 720 件のアラートを発し、通知疲弊で初回の本物の通知が埋もれる。Nagios/PagerDuty
// と同じく「状態遷移時に 1 回通知 + 継続中は再通知間隔でのみ再通知 + 復帰時に
// service_recovered」とする。監査ログとカウンタは従来通り毎 tick 記録する
// （ローカルの逐次証跡とメトリクスには連続性が要るため）。
//   name -> { downSince:number, lastDownAlertAt:number, lastFailAlertAt:number }
const _serviceState = new Map();
const RENOTIFY_MS = parseInt(process.env.SERVICE_MONITOR_RENOTIFY_MS, 10) || 5 * 60 * 1000;

// jest.spyOn(monitor, 'notifyExternalAlert') が内部呼び出しを捕捉できるよう、
// 呼び出し時点で module.exports を引き直す（auditLog と同じモジュール参照方式）。
const _notify = (...args) => module.exports.notifyExternalAlert(...args);

// 監視 tick の再入ガード。isHealthy()/initialize() が監視間隔より長くブロック
// した場合、setInterval の次の tick が前回実行と重なり、同一サービスの restart
// が並行して走る。前回 tick 完了までは次の tick をスキップする。
let _monitorRunning = false;

// 外部通知hook（Slack/Sentry/LINE/他サービス拡張）
async function notifyExternalAlert(event, data) {
  // 各チャネルの通知モジュール require は、対応する env が設定されている場合のみ行う。
  // 旧実装は env チェックより前に require していたため、未設定でも
  // scripts/sentry-notify.js → @sentry/node（未導入）の解決に失敗し、アラートごとに
  // 「モジュール呼び出し失敗」警告を量産していた（本物の障害がログに埋もれる衛生問題）。
  // env ゲートにより、未設定チャネルでは require 自体を行わずノイズを出さない。
  // Slack通知（SLACK_WEBHOOK_URL 設定時のみ）
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const { sendSlackMessage } = require('../../scripts/slack-notify.js');
      await sendSlackMessage(`[${event}] ${JSON.stringify(data)}`);
      logger.info(`[ExternalAlert] Slack通知送信: ${event}`);
    } catch (e) {
      logger.warn(`[ExternalAlert] Slack通知モジュール呼び出し失敗:`, e);
    }
  }
  // Sentry通知（SENTRY_DSN 設定時のみ）
  if (process.env.SENTRY_DSN) {
    try {
      const { sendSentryNotification } = require('../../scripts/sentry-notify.js');
      await sendSentryNotification(event, data);
      logger.info(`[ExternalAlert] Sentry通知送信: ${event}`);
    } catch (e) {
      logger.warn(`[ExternalAlert] Sentry通知モジュール呼び出し失敗:`, e);
    }
  }
  // LINE通知（LINE_TOKEN 設定時のみ）
  if (process.env.LINE_TOKEN) {
    try {
      const { sendLineNotification } = require('../../scripts/line-notify.js');
      await sendLineNotification(event, data);
      logger.info(`[ExternalAlert] LINE通知送信: ${event}`);
    } catch (e) {
      logger.warn(`[ExternalAlert] LINE通知モジュール呼び出し失敗:`, e);
    }
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
  if (_monitorRunning) {
    logger.debug('[Monitor] Previous tick still running; skipping');
    return;
  }
  _monitorRunning = true;
  try {
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;
      try {
        const healthy = await isServiceHealthy(name, svc);
        const now = Date.now();
        if (healthy) {
          // 復帰エッジ: ダウン通知済みのサービスが健全へ戻ったときだけ
          // service_recovered を1回送り、通知状態をリセットする。
          const st = _serviceState.get(name);
          if (st) {
            logger.info(`[Monitor] ${name} recovered.`);
            auditLog.appendAuditLog('service_recovered', { service: name, downForMs: now - st.downSince });
            await _notify('service_recovered', { service: name, downForMs: now - st.downSince });
            _serviceState.delete(name);
          }
          continue;
        }
        const st = _serviceState.get(name) || { downSince: now, lastDownAlertAt: 0, lastFailAlertAt: 0, restartNotified: false };
        _serviceState.set(name, st);

        logger.error(`[Monitor] ${name} unhealthy. Attempting restart.`);
        auditLog.appendAuditLog('service_down', { service: name });
        serviceDownCounter.inc({ service: name });
        // 不健全エッジ（最初の検出）または再通知間隔を超えたときだけ外部通知する。
        if (now - st.lastDownAlertAt >= RENOTIFY_MS) {
          st.lastDownAlertAt = now;
          await _notify('service_down', { service: name });
        }
        try {
          let restarted = false;
          if (typeof svc.initialize === 'function') {
            await svc.initialize();
            restarted = true;
          } else if (typeof svc.start === 'function') {
            await svc.start();
            restarted = true;
          }
          if (restarted) {
            logger.info(`[Monitor] ${name} restarted successfully.`);
            auditLog.appendAuditLog('service_restart', { service: name });
            serviceRestartCounter.inc({ service: name });
            // 再起動「成功」しても不健全のままの場合、毎 tick service_restart が
            // 飛び続けるため、ダウン窓内では最初の成功1回だけ通知する。
            if (!st.restartNotified) {
              st.restartNotified = true;
              await _notify('service_restart', { service: name });
            }
          }
        } catch (e) {
          logger.error(`[Monitor] ${name} restart failed:`, e);
          auditLog.appendAuditLog('service_restart_failed', { service: name, error: e.message });
          // 再起動失敗も service_down と同じ間隔でスロットルする。
          if (now - st.lastFailAlertAt >= RENOTIFY_MS) {
            st.lastFailAlertAt = now;
            await _notify('service_restart_failed', { service: name, error: e.message });
          }
        }
      } catch (e) {
        logger.error(`[Monitor] Exception during monitoring ${name}:`, e);
      }
    }
  } finally {
    _monitorRunning = false;
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
  // 二重起動で既存タイマーが取り残されるのを防ぐ（_timer を上書きすると
  // 旧タイマーは clearInterval できず永久に発火し続ける）。
  if (_timer) {
    logger.warn('[Monitor] Service monitor already running; ignoring second start');
    return;
  }
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
  _serviceState.clear();
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
  RENOTIFY_MS,
};

// テスト用: 通知状態と再入フラグを初期化する。
module.exports._resetMonitorStateForTest = () => {
  _serviceState.clear();
  _monitorRunning = false;
};
