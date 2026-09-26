// 外向き HTTP 呼び出しのタイムアウト付与を検証するテスト。
// axios 既定は timeout=0（無制限）のため、下流障害時に決済/通知呼び出しが
// 無期限ハングし worker を枯渇させるリスクがあった。
jest.mock('axios');
const axios = require('axios');

describe('outbound HTTP timeout', () => {
  beforeEach(() => {
    axios.post.mockReset();
    axios.get.mockReset();
  });

  it('Lightning API: OpenNode 送金に timeout を指定する', async () => {
    process.env.LN_PROVIDER = 'opennode';
    process.env.LN_BASE_URL = 'https://api.opennode.com';
    axios.post.mockResolvedValue({ data: {} });
    const { sendLightningPayment } = require('../../src/api/utils/lightning-api');
    await sendLightningPayment('addr', 0.001);
    const cfg = axios.post.mock.calls[0][2];
    expect(cfg.timeout).toBeGreaterThan(0);
  });

  it('Lightning API: LNbits 送金にも timeout を指定する', async () => {
    process.env.LN_PROVIDER = 'lnbits';
    axios.post.mockResolvedValue({ data: {} });
    const { sendLightningPayment } = require('../../src/api/utils/lightning-api');
    await sendLightningPayment('lnbc...', 0.001);
    const cfg = axios.post.mock.calls[0][2];
    expect(cfg.timeout).toBeGreaterThan(0);
  });

  it('email: SendGrid 送信に timeout を指定する', async () => {
    axios.post.mockResolvedValue({});
    const { sendEmailNotification } = require('../../src/utils/email');
    await sendEmailNotification({ to: 'a@b.c', subject: 's', text: 't' },
      { EMAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'k', EMAIL_FROM: 'f@x.y' });
    const cfg = axios.post.mock.calls[0][2];
    expect(cfg.timeout).toBeGreaterThan(0);
  });

  it('gpu-price-compare: AWS 価格 API 取得に timeout を指定する', async () => {
    axios.get.mockResolvedValue({ data: { products: {} } });
    const { fetchAWSEC2GPUPrices } = require('../../src/utils/gpu-price-compare');
    await fetchAWSEC2GPUPrices('us-east-1');
    const cfg = axios.get.mock.calls[0][1];
    expect(cfg.timeout).toBeGreaterThan(0);
  });
});
