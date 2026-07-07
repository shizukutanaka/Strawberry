// user-notify の純関数 resolveChannels のテスト（ネットワーク送信なし）
const { resolveChannels, notifyUser } = require('../../src/utils/user-notify');

describe('user-notify resolveChannels', () => {
  it('returns empty for missing/empty settings', () => {
    expect(resolveChannels(undefined, 'order_created')).toEqual([]);
    expect(resolveChannels({}, 'order_created')).toEqual([]);
    expect(resolveChannels(null, 'order_created')).toEqual([]);
  });

  it('resolves configured channels', () => {
    const channels = resolveChannels({
      lineToken: 'tok',
      discordWebhook: 'https://discord.example/wh',
      email: 'p@example.com',
    }, 'order_created');
    const types = channels.map(c => c.type);
    expect(types).toContain('line');
    expect(types).toContain('discord');
    expect(types).toContain('email');
    expect(channels.length).toBe(3);
  });

  it('respects the enabled map (explicit false disables a channel)', () => {
    const channels = resolveChannels({
      lineToken: 'tok',
      slackWebhook: 'https://slack.example/wh',
      enabled: { line: false },
    }, 'order_created');
    const types = channels.map(c => c.type);
    expect(types).not.toContain('line');
    expect(types).toContain('slack');
  });

  it('includes event-specific webhooks only when the event matches and is enabled', () => {
    const settings = {
      webhooks: [
        { event: 'order_created', url: 'https://a.example/hook', enabled: true },
        { event: 'order_cancelled', url: 'https://b.example/hook', enabled: true },
        { event: 'order_created', url: 'https://c.example/hook', enabled: false },
      ],
    };
    const channels = resolveChannels(settings, 'order_created');
    expect(channels.length).toBe(1);
    expect(channels[0].options.webhookUrl).toBe('https://a.example/hook');
  });

  it('notifyUser is a safe no-op for users without settings', () => {
    expect(notifyUser('no-such-user-id', 'order_created', 'msg')).toBe(0);
    expect(notifyUser(undefined, 'order_created', 'msg')).toBe(0);
  });
});
