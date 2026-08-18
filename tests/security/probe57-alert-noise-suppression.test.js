// tests/security/probe57-alert-noise-suppression.test.js
// Probe 57 (operational log-hygiene): notifyExternalAlert previously require()'d each
// notify script BEFORE checking its env var, so with no channel configured it still
// tried to load scripts/sentry-notify.js -> @sentry/node (not installed) and logged a
// "モジュール呼び出し失敗" warning on EVERY alert — flooding logs and burying real
// failures. 通知の実装は src/utils/external-alerts.js に移り、未設定チャネルは
// ネットワークにも触れず静かに not_configured を返す。

const { logger } = require('../../src/utils/logger');
const monitor = require('../../src/core/service-monitor');

describe('notifyExternalAlert: no module-load noise when channels are unconfigured', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ['SLACK_WEBHOOK_URL', 'SENTRY_DSN', 'LINE_TOKEN']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ['SLACK_WEBHOOK_URL', 'SENTRY_DSN', 'LINE_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  it('emits no "モジュール呼び出し失敗" warning when no channel env is set', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await monitor.notifyExternalAlert('service_down', { service: 'x' });
    const messages = warnSpy.mock.calls.map(c => String(c[0]));
    // No load-failure warnings (Slack/Sentry/LINE module require失敗)
    expect(messages.some(m => /モジュール呼び出し失敗/.test(m))).toBe(false);
    // The alert itself is still recorded locally exactly once
    const alertLines = messages.filter(m => /\[ExternalAlert\] service_down/.test(m));
    expect(alertLines.length).toBe(1);
  });

  it('performs no work at all when no channel is configured', () => {
    // 旧テストは service-monitor のソース構造（env チェックが require より前か）を
    // 検査していた。通知の実装を src/utils/external-alerts.js へ移し、チャネルの
    // 判定はモジュール内部で行うようになったので、構造ではなく**振る舞い**を見る。
    const alerts = require('../../src/utils/external-alerts');
    expect(alerts.configuredChannels()).toEqual([]);
    return alerts.notifyAll('service_down', { service: 'x' })
      .then((results) => expect(results).toEqual([]));
  });

  it('reports not_configured per channel instead of throwing', async () => {
    const alerts = require('../../src/utils/external-alerts');
    expect(await alerts.sendSlackMessage('x')).toEqual({ sent: false, reason: 'not_configured' });
    expect(await alerts.sendLineNotification('e', {})).toEqual({ sent: false, reason: 'not_configured' });
    expect(await alerts.sendSentryNotification('e', {})).toEqual({ sent: false, reason: 'not_configured' });
  });
});
