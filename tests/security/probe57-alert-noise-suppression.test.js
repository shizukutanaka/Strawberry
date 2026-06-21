// tests/security/probe57-alert-noise-suppression.test.js
// Probe 57 (operational log-hygiene): notifyExternalAlert previously require()'d each
// notify script BEFORE checking its env var, so with no channel configured it still
// tried to load scripts/sentry-notify.js -> @sentry/node (not installed) and logged a
// "モジュール呼び出し失敗" warning on EVERY alert — flooding logs and burying real
// failures. The require is now gated behind the env var, so unconfigured channels are
// silent.

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

  it('source: each notify require is gated behind its env var', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/service-monitor.js'), 'utf-8'
    );
    // The env check must precede the require for each channel
    const sentryEnvIdx = src.indexOf("if (process.env.SENTRY_DSN)");
    const sentryReqIdx = src.indexOf("require('../../scripts/sentry-notify.js')");
    expect(sentryEnvIdx).toBeGreaterThan(-1);
    expect(sentryReqIdx).toBeGreaterThan(sentryEnvIdx);

    const slackEnvIdx = src.indexOf("if (process.env.SLACK_WEBHOOK_URL)");
    const slackReqIdx = src.indexOf("require('../../scripts/slack-notify.js')");
    expect(slackReqIdx).toBeGreaterThan(slackEnvIdx);

    const lineEnvIdx = src.indexOf("if (process.env.LINE_TOKEN)");
    const lineReqIdx = src.indexOf("require('../../scripts/line-notify.js')");
    expect(lineReqIdx).toBeGreaterThan(lineEnvIdx);
  });
});
