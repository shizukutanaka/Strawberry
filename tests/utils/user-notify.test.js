// src/utils/user-notify.js — resolveChannels（純関数）と loadAllSettings（stat ゲート
// キャッシュ）の契約を固定するテスト。notification-settings で登録した個別チャネルへの
// イベント配送ルールの中核ロジックだが直接テストが無かった。
const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('../../src/db/json/data-dir');
const { notifyUser, resolveChannels, _loadAllSettings: loadAllSettings, _resetSettingsCache } = require('../../src/utils/user-notify');
const { NotifyType } = require('../../src/utils/notifier');

describe('resolveChannels', () => {
  it('returns [] for missing/invalid settings', () => {
    expect(resolveChannels(null, 'e')).toEqual([]);
    expect(resolveChannels(undefined, 'e')).toEqual([]);
    expect(resolveChannels('x', 'e')).toEqual([]);
    expect(resolveChannels({}, 'e')).toEqual([]);
  });

  it('resolves each channel from its credential fields', () => {
    const settings = {
      lineToken: 'lt', discordWebhook: 'dw', slackWebhook: 'sw',
      telegramBotToken: 'tb', telegramChatId: 'tc',
      email: 'e@x.y', genericWebhook: 'gw',
    };
    const types = resolveChannels(settings, 'e').map((c) => c.type);
    expect(types).toEqual([
      NotifyType.LINE, NotifyType.DISCORD, NotifyType.SLACK,
      NotifyType.TELEGRAM, NotifyType.EMAIL, NotifyType.WEBHOOK,
    ]);
  });

  it('requires both telegram token and chatId', () => {
    expect(resolveChannels({ telegramBotToken: 't' }, 'e')).toEqual([]);
    expect(resolveChannels({ telegramChatId: 'c' }, 'e')).toEqual([]);
    expect(resolveChannels({ telegramBotToken: 't', telegramChatId: 'c' }, 'e'))
      .toEqual([{ type: NotifyType.TELEGRAM, options: { botToken: 't', chatId: 'c' } }]);
  });

  it('enabled:false disables a channel; unspecified stays enabled', () => {
    const base = { lineToken: 'lt', discordWebhook: 'dw' };
    expect(resolveChannels(base, 'e').map((c) => c.type))
      .toEqual([NotifyType.LINE, NotifyType.DISCORD]);
    expect(resolveChannels({ ...base, enabled: { line: false } }, 'e').map((c) => c.type))
      .toEqual([NotifyType.DISCORD]);
    expect(resolveChannels({ ...base, enabled: { line: false, discord: false } }, 'e'))
      .toEqual([]);
  });

  it('event-scoped webhooks fire only on matching event with enabled+url', () => {
    const settings = {
      webhooks: [
        { event: 'order_created', url: 'https://a.example/h', enabled: true },
        { event: 'order_created', url: 'https://b.example/h', enabled: false },
        { event: 'other', url: 'https://c.example/h' },
        { event: 'order_created' }, // url なし
      ],
    };
    const ch = resolveChannels(settings, 'order_created');
    expect(ch).toEqual([{ type: NotifyType.WEBHOOK, options: { webhookUrl: 'https://a.example/h' } }]);
    expect(resolveChannels(settings, 'other').map((c) => c.options.webhookUrl))
      .toEqual(['https://c.example/h']);
  });

  it('carries credential values into channel options', () => {
    const ch = resolveChannels({ slackWebhook: 'https://s/h' }, 'e')[0];
    expect(ch.type).toBe(NotifyType.SLACK);
    expect(ch.options.webhookUrl).toBe('https://s/h');
  });
});

describe('loadAllSettings', () => {
  const settingsPath = path.join(resolveDataDir(), 'notification-settings.json');
  let backup = null;

  beforeEach(() => {
    _resetSettingsCache();
    backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  });
  afterEach(() => {
    if (backup) fs.writeFileSync(settingsPath, backup);
    else { try { fs.rmSync(settingsPath, { force: true }); } catch (_) { /* noop */ } }
    _resetSettingsCache();
  });

  // stat 指紋は (mtimeMs:size)。連続 write が同一ミリ秒＋同サイズだと
  // 指紋が不変でキャッシュミスが起きない（速度の速い環境でフレーク）ため、
  // 呼出ごとに確実に増える mtime を使う。
  let writeSeq = 0;
  const writeSettings = (obj) => {
    fs.writeFileSync(settingsPath, JSON.stringify(obj));
    const future = new Date(Date.now() + 10_000 + writeSeq++ * 1_000);
    fs.utimesSync(settingsPath, future, future);
  };

  it('returns {} when the settings file is absent', () => {
    try { fs.rmSync(settingsPath, { force: true }); } catch (_) { /* noop */ }
    expect(loadAllSettings()).toEqual({});
  });

  it('loads settings and reflects file changes on next load (stat gate)', () => {
    writeSettings({ u1: { slackWebhook: 'https://a' } });
    expect(loadAllSettings().u1.slackWebhook).toBe('https://a');
    writeSettings({ u1: { slackWebhook: 'https://b' } });
    expect(loadAllSettings().u1.slackWebhook).toBe('https://b');
  });

  it('returns {} on corrupt JSON instead of throwing', () => {
    fs.writeFileSync(settingsPath, '{ broken');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(settingsPath, future, future);
    expect(loadAllSettings()).toEqual({});
  });
});

// notifyUser 本体の契約（設定なしの no-op・stat ゲートによる再パース抑制）を固定。
describe('notifyUser', () => {
  beforeEach(() => _resetSettingsCache());
  afterEach(() => _resetSettingsCache());

  it('is a safe no-op for users without settings', () => {
    expect(notifyUser('no-such-user-id', 'order_created', 'msg')).toBe(0);
    expect(notifyUser(undefined, 'order_created', 'msg')).toBe(0);
  });

  it('repeated calls parse the settings file at most once per change', () => {
    const spy = jest.spyOn(fs, 'readFileSync');
    try {
      notifyUser('u1', 'order_created', 'm');
      notifyUser('u2', 'order_created', 'm');
      notifyUser('u3', 'order_created', 'm');
      const settingsReads = spy.mock.calls
        .filter((c) => String(c[0]).includes('notification-settings.json'));
      expect(settingsReads.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});
