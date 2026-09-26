// LINE Notify 送信の耐障害性テスト
// - タイムアウト設定の付与（応答しない API でプロセスが滞留しない）
// - 失敗ログに axios エラー（config.headers.Authorization = LINE_TOKEN）を含めない
jest.mock('axios');

describe('line-notify sendLineNotification', () => {
  let warnSpy;

  // jest.resetModules() でモジュールを再読込するため、axios モックも再取得して返す
  function load() {
    jest.resetModules();
    const ax = require('axios');
    ax.post.mockReset().mockResolvedValue({ data: 'ok' });
    const mod = require('../../scripts/line-notify');
    return { sendLineNotification: mod.sendLineNotification, axiosMock: ax };
  }

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LINE_TOKEN;
    delete process.env.LINE_NOTIFY_TIMEOUT_MS;
  });

  it('LINE_TOKEN 未設定時は送信しない', async () => {
    const { sendLineNotification, axiosMock } = load();
    await sendLineNotification('down', { service: 'x' });
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('axios.post にタイムアウトを渡す（既定 10 秒）', async () => {
    process.env.LINE_TOKEN = 't';
    const { sendLineNotification, axiosMock } = load();
    await sendLineNotification('down', { service: 'x' });
    expect(axiosMock.post).toHaveBeenCalledWith(
      'https://notify-api.line.me/api/notify',
      expect.any(String),
      expect.objectContaining({ timeout: 10000 })
    );
  });

  it('タイムアウトは LINE_NOTIFY_TIMEOUT_MS で上書き可能', async () => {
    process.env.LINE_TOKEN = 't';
    process.env.LINE_NOTIFY_TIMEOUT_MS = '3000';
    const { sendLineNotification, axiosMock } = load();
    await sendLineNotification('down', {});
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ timeout: 3000 })
    );
  });

  it('失敗時ログに Authorization ヘッダ（トークン）を含めない', async () => {
    process.env.LINE_TOKEN = 'SECRET_LINE_TOKEN';
    const { sendLineNotification, axiosMock } = load();
    const err = new Error('Request failed with status code 500');
    err.response = { status: 500 };
    err.config = { headers: { Authorization: 'Bearer SECRET_LINE_TOKEN' } };
    axiosMock.post.mockRejectedValueOnce(err);
    await sendLineNotification('down', {});
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('HTTP 500');
    expect(logged).not.toContain('SECRET_LINE_TOKEN');
    expect(logged).not.toContain('Authorization');
  });

  it('HTTP ステータスが無い失敗は e.message のみ記録する', async () => {
    process.env.LINE_TOKEN = 'SECRET_LINE_TOKEN';
    const { sendLineNotification, axiosMock } = load();
    const err = new Error('timeout of 10000ms exceeded');
    err.config = { headers: { Authorization: 'Bearer SECRET_LINE_TOKEN' } };
    axiosMock.post.mockRejectedValueOnce(err);
    await sendLineNotification('down', {});
    const logged = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('timeout of 10000ms exceeded');
    expect(logged).not.toContain('SECRET_LINE_TOKEN');
  });
});
