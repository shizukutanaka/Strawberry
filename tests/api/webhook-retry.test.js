// Outbound webhook 配送リトライ: 一過性失敗は指数バックオフで再送、4xx は即諦め
jest.mock('axios');
jest.mock('../../src/utils/ssrf-guard', () => ({ assertPublicUrl: jest.fn().mockResolvedValue(true) }));

let sendWebhook, axios;

function loadModule() {
  jest.resetModules();
  delete process.env.WEBHOOK_SIGNING_SECRET;
  process.env.GENERIC_WEBHOOK = 'https://hooks.example.com/hook';
  process.env.WEBHOOK_MAX_ATTEMPTS = '3';
  const m = require('../../src/api/webhook');
  return { sendWebhook: m.sendWebhook, axios: require('axios') };
}

describe('webhook delivery retry', () => {
  afterEach(() => {
    delete process.env.GENERIC_WEBHOOK; delete process.env.WEBHOOK_MAX_ATTEMPTS;
    jest.clearAllMocks();
  });

  test('一過性失敗（5xx/ネットワーク）は再送して成功する', async () => {
    ({ sendWebhook, axios } = loadModule());
    axios.post
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { status: 503 } }))
      .mockResolvedValue({ status: 200 });
    await sendWebhook('ev', { a: 1 });
    expect(axios.post).toHaveBeenCalledTimes(2);
  }, 15000);

  test('4xx は恒久的拒否として再送しない', async () => {
    ({ sendWebhook, axios } = loadModule());
    axios.post.mockRejectedValue(Object.assign(new Error('bad'), { response: { status: 422 } }));
    await expect(sendWebhook('ev', {})).rejects.toThrow('全Webhook送信失敗');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('連続失敗は MAX_ATTEMPTS で打ち切る', async () => {
    ({ sendWebhook, axios } = loadModule());
    axios.post.mockRejectedValue(new Error('net down'));
    await expect(sendWebhook('ev', {})).rejects.toThrow('全Webhook送信失敗');
    expect(axios.post).toHaveBeenCalledTimes(3);
  }, 15000);
});
