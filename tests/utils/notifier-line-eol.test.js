// tests/utils/notifier-line-eol.test.js
// LINE Notify（notify-api.line.me）は 2025-03-31 にサービス終了。
// 廃止パスが dead エンドポイントへ HTTP を発行せず即エラーになること、
// 後継の LINE Messaging API パスが正しいリクエスト形状であることを検証する。
jest.mock('axios');
const axios = require('axios');
const { sendNotification, NotifyType } = require('../../src/utils/notifier');

describe('LINE Notify EOL', () => {
  beforeEach(() => jest.clearAllMocks());

  it('NotifyType.LINE fails fast with a migration message and sends no HTTP', async () => {
    await expect(sendNotification(NotifyType.LINE, 'msg', { token: 't' }))
      .rejects.toThrow(/2025-03-31.*LINE Messaging API/s);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('LINE_MESSAGING pushes via api.line.me/v2/bot/message/push with Bearer auth', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await sendNotification(NotifyType.LINE_MESSAGING, 'hello', { token: 'CAT', to: 'U123' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/message/push',
      { to: 'U123', messages: [{ type: 'text', text: 'hello' }] },
      expect.objectContaining({
        headers: { Authorization: 'Bearer CAT' },
        timeout: 10_000,
        maxRedirects: 0,
      }),
    );
  });

  it('LINE_MESSAGING requires token and destination', async () => {
    await expect(sendNotification(NotifyType.LINE_MESSAGING, 'm', {})).rejects.toThrow(/トークン未設定/);
    await expect(sendNotification(NotifyType.LINE_MESSAGING, 'm', { token: 't' })).rejects.toThrow(/送信先/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
