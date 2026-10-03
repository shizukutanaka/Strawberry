// src/utils/resilient-notify.js — 冗長化通知のフェイルオーバー契約を固定するテスト。
// CHANNELS はモジュール読込時に env から構築されるため、各テストで env を設定してから
// jest.resetModules + require し直す。axios.post / assertPublicUrl はモック化。
jest.mock('../../src/utils/ssrf-guard', () => ({ assertPublicUrl: jest.fn() }));

const NOTIFY_ENV_KEYS = [
  'LINE_NOTIFY_URL', 'LINE_TOKEN', 'DISCORD_WEBHOOK', 'SLACK_WEBHOOK',
  'TELEGRAM_API_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  'EMAIL_API_URL', 'EMAIL_API_KEY', 'EMAIL_TO', 'GENERIC_WEBHOOK',
];

describe('resilientNotify', () => {
  const savedEnv = {};

  const setup = (env = {}) => {
    jest.resetModules();
    for (const k of NOTIFY_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    const axios = require('axios');
    const postSpy = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200 });
    const { assertPublicUrl } = require('../../src/utils/ssrf-guard');
    assertPublicUrl.mockReset().mockResolvedValue(undefined);
    const { resilientNotify } = require('../../src/utils/resilient-notify');
    return { postSpy, resilientNotify, assertPublicUrl };
  };

  beforeEach(() => {
    for (const k of NOTIFY_ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of NOTIFY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    jest.restoreAllMocks();
  });

  it('throws when no channel is configured', async () => {
    const { postSpy, resilientNotify } = setup({});
    await expect(resilientNotify('hello')).rejects.toThrow('全通知チャネルで送信失敗');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('posts to the first configured channel and stops', async () => {
    const { postSpy, resilientNotify } = setup({
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      SLACK_WEBHOOK: 'https://slack.example/hook',
    });
    await expect(resilientNotify('hello')).resolves.toBeUndefined();
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('https://discord.example/hook', { content: 'hello' }, expect.anything());
  });

  it('fails over to the next channel when the first errors', async () => {
    const { postSpy, resilientNotify } = setup({
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      SLACK_WEBHOOK: 'https://slack.example/hook',
    });
    postSpy
      .mockRejectedValueOnce(new Error('discord down'))
      .mockResolvedValueOnce({ status: 200 });
    await expect(resilientNotify('hello')).resolves.toBeUndefined();
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1][0]).toBe('https://slack.example/hook');
  });

  it('rejects after exhausting all configured channels', async () => {
    const { postSpy, resilientNotify } = setup({
      DISCORD_WEBHOOK: 'https://discord.example/hook',
      SLACK_WEBHOOK: 'https://slack.example/hook',
      GENERIC_WEBHOOK: 'https://generic.example/hook',
    });
    postSpy.mockRejectedValue(new Error('all down'));
    await expect(resilientNotify('hello')).rejects.toThrow('全通知チャネルで送信失敗');
    expect(postSpy).toHaveBeenCalledTimes(3);
  });

  it('skips SSRF-blocked channel URLs without posting', async () => {
    const { postSpy, resilientNotify, assertPublicUrl } = setup({
      DISCORD_WEBHOOK: 'http://169.254.169.254/latest',
      SLACK_WEBHOOK: 'https://slack.example/hook',
    });
    assertPublicUrl.mockImplementation(async (url) => {
      if (String(url).includes('169.254')) throw new Error('private IP blocked');
    });
    await expect(resilientNotify('hello')).resolves.toBeUndefined();
    // SSRF 拒否チャネルは post されず slack 1回のみ
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('https://slack.example/hook', { content: 'hello' }, expect.anything());
  });

  it('throws when every channel is SSRF-blocked', async () => {
    const { postSpy, resilientNotify, assertPublicUrl } = setup({
      DISCORD_WEBHOOK: 'http://10.0.0.1/hook',
    });
    assertPublicUrl.mockRejectedValue(new Error('private IP blocked'));
    await expect(resilientNotify('hello')).rejects.toThrow('全通知チャネルで送信失敗');
    expect(postSpy).not.toHaveBeenCalled();
  });
});
