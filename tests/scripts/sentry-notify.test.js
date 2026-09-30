// tests/scripts/sentry-notify.test.js — sentry-notify が @sentry/node 未導入でも
// require 時にクラッシュしないこと（service-monitor の遅延 require が
// SENTRY_DSN 設定環境で MODULE_NOT_FOUND を起こさないこと）を保証する。
describe('sentry-notify', () => {
  const MODULE_PATH = '../../scripts/sentry-notify';

  afterEach(() => {
    jest.resetModules();
    delete process.env.SENTRY_DSN;
  });

  it('@sentry/node 未導入でも require できる', () => {
    expect(() => require(MODULE_PATH)).not.toThrow();
    const mod = require(MODULE_PATH);
    expect(typeof mod.sendSentryNotification).toBe('function');
    expect(typeof mod.initSentry).toBe('function');
  });

  it('SENTRY_DSN 未設定時は sendSentryNotification が何もしない', async () => {
    const { sendSentryNotification } = require(MODULE_PATH);
    await expect(sendSentryNotification('evt', { a: 1 })).resolves.toBeUndefined();
  });

  it('SENTRY_DSN 設定時に @sentry/node 未導入なら導入手順の分かるエラー', async () => {
    process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0';
    const { sendSentryNotification } = require(MODULE_PATH);
    await expect(sendSentryNotification('evt', {})).rejects.toThrow(/npm install @sentry\/node/);
  });
});
