// Exercises src/utils/notifier.js — the multi-channel notification dispatcher
// (LINE / Discord / Slack / Telegram / Email / Webhook) plus its withRetry
// backoff helper. axios, the SSRF guard, and the email sender are mocked so no
// real network calls happen; the focus is the dispatch/validation/retry logic.
jest.mock('axios');
jest.mock('../../src/utils/ssrf-guard', () => ({ assertPublicUrl: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/utils/email', () => ({ sendEmailNotification: jest.fn().mockResolvedValue({ ok: true }) }));

const axios = require('axios');
const { assertPublicUrl } = require('../../src/utils/ssrf-guard');
const { sendEmailNotification } = require('../../src/utils/email');
const { sendNotification, NotifyType, withRetry } = require('../../src/utils/notifier');

beforeEach(() => {
  jest.clearAllMocks();
  axios.post = jest.fn().mockResolvedValue({ data: { ok: true } });
});

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('done');
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a 4xx client error', async () => {
    const err = Object.assign(new Error('bad'), { response: { status: 422 } });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts on a 5xx/transient error then throws last error', async () => {
    const err = Object.assign(new Error('boom'), { response: { status: 503 } });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('recovers if a later attempt succeeds', async () => {
    const err = Object.assign(new Error('temp'), { response: { status: 500 } });
    const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await expect(withRetry(fn, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('sendNotification type dispatch', () => {
  it('LINE posts to the LINE notify API with a bearer token', async () => {
    await sendNotification(NotifyType.LINE, 'hi', { token: 'tok123' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://notify-api.line.me/api/notify',
      expect.anything(),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok123' }) }),
    );
  });

  it('LINE without a token rejects', async () => {
    await expect(sendNotification(NotifyType.LINE, 'hi', {})).rejects.toThrow('LINEトークン未設定');
  });

  it('Discord runs the SSRF guard then posts content', async () => {
    await sendNotification(NotifyType.DISCORD, 'hello', { webhookUrl: 'https://discord.test/wh' });
    expect(assertPublicUrl).toHaveBeenCalledWith('https://discord.test/wh');
    expect(axios.post).toHaveBeenCalledWith('https://discord.test/wh', { content: 'hello' }, expect.anything());
  });

  it('Slack posts text through the guarded webhook', async () => {
    await sendNotification(NotifyType.SLACK, 'yo', { webhookUrl: 'https://slack.test/wh' });
    expect(assertPublicUrl).toHaveBeenCalledWith('https://slack.test/wh');
    expect(axios.post).toHaveBeenCalledWith('https://slack.test/wh', { text: 'yo' }, expect.anything());
  });

  it('Telegram validates botToken/chatId formats before sending', async () => {
    await expect(sendNotification(NotifyType.TELEGRAM, 'm', { botToken: 'bad', chatId: '1' }))
      .rejects.toThrow('botToken format invalid');
    const goodToken = `${'1'.repeat(8)}:${'A'.repeat(35)}`;
    await sendNotification(NotifyType.TELEGRAM, 'm', { botToken: goodToken, chatId: '12345' });
    expect(axios.post).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${goodToken}/sendMessage`,
      { chat_id: '12345', text: 'm' },
      expect.anything(),
    );
  });

  it('Email delegates to sendEmailNotification with a default subject', async () => {
    await sendNotification(NotifyType.EMAIL, 'body', { to: 'a@b.co' });
    expect(sendEmailNotification).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.co', subject: 'Strawberry Marketplace 通知', text: 'body' }),
      undefined,
    );
  });

  it('Webhook guards then posts the message merged with the payload', async () => {
    await sendNotification(NotifyType.WEBHOOK, 'msg', { webhookUrl: 'https://hook.test/x', payload: { a: 1 } });
    expect(assertPublicUrl).toHaveBeenCalledWith('https://hook.test/x');
    expect(axios.post).toHaveBeenCalledWith('https://hook.test/x', { message: 'msg', a: 1 }, expect.anything());
  });

  it('an unknown type rejects', async () => {
    await expect(sendNotification('carrier-pigeon', 'm', {})).rejects.toThrow('Unknown notification type');
  });
});

describe('sendNotification multi-channel (user_ prefixed)', () => {
  const fs = require('fs');
  const path = require('path');
  const settingsPath = path.resolve(__dirname, '../../data/notification-settings.json');
  const userId = 'user_multichan';

  afterEach(() => {
    try { fs.writeFileSync(settingsPath, '{}', 'utf-8'); } catch (_) {}
  });

  it('fans out to every enabled channel and to per-event webhooks', async () => {
    const goodToken = `${'2'.repeat(8)}:${'B'.repeat(35)}`;
    fs.writeFileSync(settingsPath, JSON.stringify({
      [userId]: {
        enabled: { line: true, discord: true, slack: true, telegram: true, email: true, webhook: true },
        lineToken: 'ltok',
        discordWebhook: 'https://d.test/wh',
        slackWebhook: 'https://s.test/wh',
        telegramBotToken: goodToken,
        telegramChatId: '999',
        email: 'u@e.co',
        genericWebhook: 'https://g.test/wh',
        webhooks: [
          { url: 'https://ev.test/match', event: 'order_paid', enabled: true, payloadTemplate: '{"text":"${message}"}' },
          { url: 'https://ev.test/other', event: 'other_event', enabled: true },
          { url: 'https://ev.test/disabled', enabled: false },
        ],
      },
    }), 'utf-8');

    await sendNotification(userId, 'hello world', { event: 'order_paid' });

    // 4 webhook-style axios posts (discord, slack, generic, + the one matching webhook)
    // plus line + telegram; email goes through sendEmailNotification (not axios).
    const postedUrls = axios.post.mock.calls.map((c) => c[0]);
    expect(postedUrls).toContain('https://d.test/wh');
    expect(postedUrls).toContain('https://s.test/wh');
    expect(postedUrls).toContain('https://g.test/wh');
    expect(postedUrls).toContain('https://ev.test/match');
    // event-filtered: the 'other_event' webhook must NOT fire for order_paid
    expect(postedUrls).not.toContain('https://ev.test/other');
    // disabled webhook must NOT fire
    expect(postedUrls).not.toContain('https://ev.test/disabled');
    expect(sendEmailNotification).toHaveBeenCalled();
  });

  it('returns an empty result set when the user has no settings', async () => {
    fs.writeFileSync(settingsPath, '{}', 'utf-8');
    const res = await sendNotification('user_nobody', 'x', {});
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(0);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
