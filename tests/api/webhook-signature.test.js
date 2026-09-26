// Outbound webhook の HMAC 署名: 受信側が送信者正当性と鮮度を検証できる
// X-Strawberry-Signature: t=<unix>,v1=<hmac-sha256(`${t}.${rawBody}`)>
const crypto = require('crypto');

jest.mock('axios');
jest.mock('../../src/utils/ssrf-guard', () => ({ assertPublicUrl: jest.fn().mockResolvedValue(true) }));

const SECRET = 'test-webhook-secret';
let signWebhookBody, sendWebhook, axios;

// resetModules 後は webhook.js とテストが同じ axios モックインスタンスを参照するよう、
// ロード時に require し直して返す（別インスタンスだと calls が観測できない）。
function loadModule(secret) {
  jest.resetModules();
  if (secret === undefined) delete process.env.WEBHOOK_SIGNING_SECRET;
  else process.env.WEBHOOK_SIGNING_SECRET = secret;
  process.env.GENERIC_WEBHOOK = 'https://hooks.example.com/hook';
  const m = require('../../src/api/webhook');
  return { ...m, axios: require('axios') };
}

describe('webhook HMAC signature', () => {
  afterEach(() => { delete process.env.WEBHOOK_SIGNING_SECRET; delete process.env.GENERIC_WEBHOOK; jest.clearAllMocks(); });

  test('署名ヘッダは t + v1 で、受信側が同じ HMAC を再計算できる', async () => {
    ({ signWebhookBody, sendWebhook, axios } = loadModule(SECRET));
    axios.post.mockResolvedValue({ status: 200 });
    await sendWebhook('test_event', { a: 1 });

    const [url, rawBody, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/hook');
    const sig = opts.headers['X-Strawberry-Signature'];
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(m).toBeTruthy();
    const expected = crypto.createHmac('sha256', SECRET).update(`${m[1]}.${rawBody}`).digest('hex');
    expect(m[2]).toBe(expected);
    // timestamp は現在時刻に近い（リプレイ窓の前提）
    expect(Math.abs(Date.now() / 1000 - Number(m[1]))).toBeLessThan(60);
  });

  test('改ざん body では署名が一致しない（受信側検証が失敗する）', async () => {
    ({ sendWebhook, axios } = loadModule(SECRET));
    axios.post.mockResolvedValue({ status: 200 });
    await sendWebhook('ev', { x: 1 });
    const [, rawBody, opts] = axios.post.mock.calls[0];
    const m = opts.headers['X-Strawberry-Signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    const tampered = crypto.createHmac('sha256', SECRET).update(`${m[1]}.${rawBody}x`).digest('hex');
    expect(tampered).not.toBe(m[2]);
  });

  test('SECRET 未設定時は署名ヘッダ無しで送信（後方互換）', async () => {
    ({ sendWebhook, axios } = loadModule(undefined));
    axios.post.mockResolvedValue({ status: 200 });
    await sendWebhook('ev', { x: 1 });
    expect(axios.post.mock.calls[0][2].headers['X-Strawberry-Signature']).toBeUndefined();
  });
});
