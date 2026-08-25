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
const _svcState = new Map();
const RESTART_BASE_DELAY_MS = 30 * 1000;   // 初回リトライまで 30 秒
const RESTART_MAX_DELAY_MS = 30 * 60 * 1000; // 上限 30 分
const GIVE_UP_AFTER = 10;                  // これを超えたら再起動を諦めて通知だけ残す

function setServices(refs) {
  services = refs;
  // 監視対象から外れたサービスの状態を捨てる。残したままだと、同名のサービスを
  // 後から登録し直したときに「前回落ちていた」状態を引き継ぎ、初回のヘルスチェックが
  // 通っただけで service_recovered を誤発報する。
  for (const name of [..._svcState.keys()]) {
    if (!refs || !Object.prototype.hasOwnProperty.call(refs, name)) _svcState.delete(name);
  }
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

// サービスごとの復旧状態。復旧できないサービスを 10 秒ごとに再起動し続け、
// そのたびに通知を撃つのを防ぐ。
//   consecutiveFailures … 連続で unhealthy だった回数
//   nextAttemptAt       … 次に再起動を試みてよい時刻（指数バックオフ）
//   alerted             … ダウン通知を既に送ったか（状態遷移でのみ通知する）
function _stateFor(name) {
  if (!_svcState.has(name)) {
    _svcState.set(name, { consecutiveFailures: 0, nextAttemptAt: 0, alerted: false });
  }
  return _svcState.get(name);
}

/**
 * サービスの死活監視・自動復旧。
 *
 * **通知は状態が変わったときだけ出す。** 以前は unhealthy を検出するたびに
 * service_down と service_restart を送っていたため、復旧しないサービスが 1 つでも
 * あると 10 秒ごとに通知が 2 通ずつ延々と飛び続けた（VirtualGPUManager の
 * isHealthy が「割り当て中の GPU が 0 件＝unhealthy」と誤判定していたため、
 * 実際に無限ループしていた）。通知が届かない間は誰も気づけなかったが、
 * 外部通知が実際に機能するようになった以上、これはチャネルを埋め尽くす。
 *
 * 再起動も指数バックオフし、一定回数を超えたら諦める。同じやり方で失敗し続ける
 * 再起動を無限に繰り返しても復旧しないうえ、本物の障害シグナルを覆い隠す。
 */
async function monitorServices() {
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    try {
      const healthy = await isServiceHealthy(name, svc);
      const st = _stateFor(name);

      if (healthy) {
        // 復旧した場合だけ通知する（正常が続いている間は無言）。
        if (st.alerted) {
          logger.info(`[Monitor] ${name} recovered after ${st.consecutiveFailures} failed check(s).`);
          auditLog.appendAuditLog('service_recovered', { service: name, afterFailures: st.consecutiveFailures });
          await notifyExternalAlert('service_recovered', { service: name });
        }
        st.consecutiveFailures = 0;
        st.nextAttemptAt = 0;
        st.alerted = false;
        continue;
      }

      st.consecutiveFailures += 1;
      // ダウン通知は落ちた瞬間に 1 度だけ。
      if (!st.alerted) {
        st.alerted = true;
        logger.error(`[Monitor] ${name} unhealthy.`);
        auditLog.appendAuditLog('service_down', { service: name });
        serviceDownCounter.inc({ service: name });
        await notifyExternalAlert('service_down', { service: name });
      }

      if (st.consecutiveFailures > GIVE_UP_AFTER) {
        // 諦めた後も監視は続ける（復旧すれば service_recovered が飛ぶ）。
        continue;
      }
      const now = Date.now();
      if (now < st.nextAttemptAt) continue; // バックオフ中

      // 次回の待ち時間を先に伸ばす（再起動が例外で抜けても効くように）。
      const backoff = Math.min(
        RESTART_BASE_DELAY_MS * Math.pow(2, st.consecutiveFailures - 1),
        RESTART_MAX_DELAY_MS,
      );
      st.nextAttemptAt = now + backoff;

      try {
        const restart = typeof svc.initialize === 'function' ? svc.initialize.bind(svc)
          : typeof svc.start === 'function' ? svc.start.bind(svc)
          : null;
        if (!restart) continue;
        await restart();
        // ここで「復旧した」と通知はしない。次回のヘルスチェックが通って初めて
        // service_recovered を出す（起動しただけで健全とは限らない）。
        logger.info(`[Monitor] ${name} restart attempted (failure #${st.consecutiveFailures}).`);
        auditLog.appendAuditLog('service_restart', { service: name, attempt: st.consecutiveFailures });
        serviceRestartCounter.inc({ service: name });
      } catch (e) {
        logger.error(`[Monitor] ${name} restart failed:`, e);
        auditLog.appendAuditLog('service_restart_failed', { service: name, error: e.message });
        // 再起動失敗の通知もダウン通知に含まれているので繰り返さない。
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
  _resetMonitorStateForTest: () => _svcState.clear(),
  _monitorStateForTest: (name) => _svcState.get(name),
  setServices,
  startMonitor,
  stopMonitor,
  monitorServices,
  isServiceHealthy,
  notifyExternalAlert,
  serviceRestartCounter,
  serviceDownCounter,
};
