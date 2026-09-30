// Slack Webhook 送信の耐障害性テスト
// - 応答しないエンドポイントで呼出プロセスが滞留しないようタイムアウトを要求
// - 不正 URL / 非 https で例外を呼出側へ投げない
const https = require('https');

describe('slack-feedback-bot sendSlackMessage', () => {
  let fakeReq;
  let requestSpy;
  let warnSpy;
  let errorSpy;

  function load() {
    jest.resetModules();
    return require('../../scripts/slack-feedback-bot');
  }

  beforeEach(() => {
    fakeReq = {
      setTimeout: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    requestSpy = jest.spyOn(https, 'request').mockImplementation(() => fakeReq);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_TIMEOUT_MS;
  });

  it('Webhook URL 未設定時は送信せず警告のみ', () => {
    delete process.env.SLACK_WEBHOOK_URL;
    const { sendSlackMessage } = load();
    sendSlackMessage('hello');
    expect(warnSpy).toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('リクエストにタイムアウトを設定し、発火時に destroy する', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    const { sendSlackMessage } = load();
    sendSlackMessage('hello');
    expect(requestSpy).toHaveBeenCalled();
    expect(fakeReq.setTimeout).toHaveBeenCalledWith(10000, expect.any(Function));
    // タイムアウト発火 → destroy でソケットを閉じる
    const onTimeout = fakeReq.setTimeout.mock.calls[0][1];
    onTimeout();
    expect(fakeReq.destroy).toHaveBeenCalled();
  });

  it('タイムアウトは SLACK_WEBHOOK_TIMEOUT_MS で上書き可能', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    process.env.SLACK_WEBHOOK_TIMEOUT_MS = '2500';
    const { sendSlackMessage } = load();
    sendSlackMessage('hello');
    expect(fakeReq.setTimeout).toHaveBeenCalledWith(2500, expect.any(Function));
  });

  it('レスポンス本文を読み捨ててソケットを解放し、非2xx をログする', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/T/B/x';
    const { sendSlackMessage } = load();
    sendSlackMessage('hello');
    const onResponse = requestSpy.mock.calls[0][1];
    const res = { statusCode: 500, resume: jest.fn() };
    onResponse(res);
    expect(res.resume).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('不正な URL で例外を投げずエラーログのみ', () => {
    process.env.SLACK_WEBHOOK_URL = 'not a url';
    const { sendSlackMessage } = load();
    expect(() => sendSlackMessage('hello')).not.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('http:// URL を拒否する（平文 Webhook 送信を防止）', () => {
    process.env.SLACK_WEBHOOK_URL = 'http://hooks.slack.com/services/T/B/x';
    const { sendSlackMessage } = load();
    sendSlackMessage('hello');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
