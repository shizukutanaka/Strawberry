// tests/utils/external-alerts.test.js
// 外部通知（Slack / LINE / Sentry）。
//
// きっかけ: service-monitor は `require('scripts/slack-notify.js').sendSlackMessage`
// を呼んでいたが、あのモジュールが export していたのは `notifyReport` だけだった。
// 毎回 undefined を呼んで例外になり、catch されて warn ログに消えていたので、
// **Slack 通知は一度も送信できていなかった**。運営は SLACK_WEBHOOK_URL を設定して
// 「障害時に通知が来る」と思っている。死んでいる通知経路は、通知経路が無いより悪い。
//
// さらに実体の sendSlackMessage は webhook 未設定時に process.exit(1) していた。
// export されていたら env の設定漏れで API サーバごと落ちていた（export 漏れが
// 偶然サーバを守っていた）。
//
// ここでは (1) 呼び出し側が使う名前が実際に export されていること、
// (2) 未設定・異常系でプロセスを殺さず結果を返すこと、を押さえる。
const alerts = require('../../src/utils/external-alerts');

const ENV_KEYS = ['SLACK_WEBHOOK_URL', 'LINE_TOKEN', 'SENTRY_DSN'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  alerts._resetSentryForTest();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the API the caller actually uses exists', () => {
  it('exports every function service-monitor calls', () => {
    // これが元のバグそのもの: 呼ぶ側の名前と export の名前が食い違っていた。
    for (const name of ['sendSlackMessage', 'sendLineNotification', 'sendSentryNotification', 'notifyAll']) {
      expect(typeof alerts[name]).toBe('function');
    }
  });

  it('service-monitor.js only destructures names this module exports', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/core/service-monitor.js'), 'utf-8');
    const used = [...src.matchAll(/external-alerts'\)\.(\w+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(typeof alerts[name]).toBe('function');
  });
});

describe('unconfigured channels', () => {
  it('return not_configured rather than throwing or exiting', async () => {
    expect(await alerts.sendSlackMessage('hello')).toEqual({ sent: false, reason: 'not_configured' });
    expect(await alerts.sendLineNotification('e', {})).toEqual({ sent: false, reason: 'not_configured' });
    expect(await alerts.sendSentryNotification('e', {})).toEqual({ sent: false, reason: 'not_configured' });
  });

  it('notifyAll returns an empty result set and touches nothing', async () => {
    expect(await alerts.notifyAll('service_down', { service: 'x' })).toEqual([]);
  });

  it('configuredChannels reflects only what is set', () => {
    expect(alerts.configuredChannels()).toEqual([]);
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.example/abc';
    process.env.LINE_TOKEN = 'tok';
    expect(alerts.configuredChannels().sort()).toEqual(['line', 'slack']);
  });
});

describe('Slack webhook validation', () => {
  it('rejects a malformed webhook URL without throwing', async () => {
    process.env.SLACK_WEBHOOK_URL = 'not a url';
    expect(await alerts.sendSlackMessage('x')).toEqual({ sent: false, reason: 'invalid_webhook_url' });
  });

  it('refuses to send a secret-bearing webhook over plain http', async () => {
    // webhook URL 自体が秘密。平文で投げてはいけない。
    process.env.SLACK_WEBHOOK_URL = 'http://hooks.example/abc';
    expect(await alerts.sendSlackMessage('x')).toEqual({ sent: false, reason: 'insecure_webhook_url' });
  });
});

describe('Sentry without the optional SDK', () => {
  it('says so explicitly instead of silently dropping the alert', async () => {
    // @sentry/node は依存に入っていない。DSN だけ設定されている運営は
    // 「通知が来る」と思っているので、黙って捨てるのが一番まずい。
    process.env.SENTRY_DSN = 'https://public@sentry.example/1';
    const res = await alerts.sendSentryNotification('service_down', { service: 'x' });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe('sentry_sdk_not_installed');
  });

  it('surfaces the failed channel through notifyAll rather than hiding it', async () => {
    process.env.SENTRY_DSN = 'https://public@sentry.example/1';
    const results = await alerts.notifyAll('service_down', { service: 'x' });
    expect(results).toEqual([{ channel: 'sentry', sent: false, reason: 'sentry_sdk_not_installed' }]);
  });
});
