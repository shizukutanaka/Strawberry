// 外向き axios 呼び出しの共通安全設定（timeout/maxRedirects/サイズ上限）の
// 適用を検証する。タイムアウト無しの axios は相手の半開きソケットに呼び出し側が
// 永久に張り付き、サイズ上限無しは巨大レスポンスでヒープを枯渇させる。
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));
const axios = require('axios');

const { AXIOS_SAFE_CONFIG } = require('../../src/utils/http-safe-config');
const { sendEmailNotification } = require('../../src/utils/email');
const { fetchAWSEC2GPUPrices } = require('../../src/utils/gpu-price-compare');

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
});

describe('AXIOS_SAFE_CONFIG', () => {
  it('凍結済みで timeout/サイズ上限/maxRedirects:0 を持つ', () => {
    expect(Object.isFrozen(AXIOS_SAFE_CONFIG)).toBe(true);
    expect(AXIOS_SAFE_CONFIG).toMatchObject({
      timeout: 10_000,
      maxContentLength: 1_048_576,
      maxBodyLength: 1_048_576,
      maxRedirects: 0,
    });
  });
});

describe('email.js（notifier 経由で配線済み）', () => {
  it('SendGrid 送信に共通安全設定が適用される', async () => {
    axios.post.mockResolvedValue({ status: 202 });
    await sendEmailNotification(
      { to: 'u@example.com', subject: 's', text: 't' },
      { EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'k', EMAIL_FROM: 'f@example.com' }
    );
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.anything(),
      expect.objectContaining({ timeout: 10_000, maxRedirects: 0 })
    );
  });

  it('Mailgun 送信に共通安全設定が適用される', async () => {
    axios.post.mockResolvedValue({ status: 200 });
    await sendEmailNotification(
      { to: 'u@example.com', subject: 's', text: 't' },
      { EMAIL_PROVIDER: 'mailgun', MAILGUN_API_KEY: 'k', MAILGUN_DOMAIN: 'mg.example.com' }
    );
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.mailgun.net/v3/mg.example.com/messages',
      expect.anything(),
      expect.objectContaining({ timeout: 10_000, maxRedirects: 0 })
    );
  });
});

describe('gpu-price-compare.js', () => {
  it('AWS pricing index の取得にタイムアウトとサイズ上限が付く（OOM/滞留の防止）', async () => {
    axios.get.mockResolvedValue({ data: { products: {} } });
    await fetchAWSEC2GPUPrices('ap-northeast-1');
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('pricing.us-east-1.amazonaws.com'),
      expect.objectContaining({
        timeout: expect.any(Number),
        maxContentLength: expect.any(Number),
        maxRedirects: 0,
      })
    );
    const cfg = axios.get.mock.calls[0][1];
    expect(cfg.timeout).toBeLessThanOrEqual(60_000);
  });
});
