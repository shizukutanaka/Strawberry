// src/utils/gpu-price-compare.js — AWS 価格 API 呼出の契約を固定するテスト。
// リージョン挿入 URL・安全既定（timeout/上限/redirect 0）・GPU 属性フィルタ・
// 失敗伝播は、OOM・滞留・誤フィルタのどれにも回帰できない不変条件。
jest.mock('axios');
const axios = require('axios');

const { fetchAWSEC2GPUPrices, fetchAzureGPUPrices } = require('../../src/utils/gpu-price-compare');

beforeEach(() => {
  axios.get.mockReset().mockResolvedValue({
    data: { products: {} },
  });
});

describe('fetchAWSEC2GPUPrices', () => {
  it('GETs the region-scoped offer index with bounded axios config', async () => {
    await fetchAWSEC2GPUPrices('us-west-2');
    expect(axios.get).toHaveBeenCalledWith(
      'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-west-2/index.json',
      { timeout: 30_000, maxContentLength: 256 * 1024 * 1024, maxRedirects: 0 },
    );
  });

  it('defaults the region to ap-northeast-1', async () => {
    await fetchAWSEC2GPUPrices();
    expect(axios.get.mock.calls[0][0]).toContain('/ap-northeast-1/');
  });

  it('returns only products with a GPU acceleratorType attribute', async () => {
    axios.get.mockResolvedValue({
      data: {
        products: {
          p1: { attributes: { acceleratorType: 'nvidia' }, sku: 'p1' },
          p2: { attributes: { instanceType: 'm5.large' }, sku: 'p2' },
          p3: { sku: 'p3' },
        },
      },
    });
    const out = await fetchAWSEC2GPUPrices();
    expect(out).toHaveLength(1);
    expect(out[0].sku).toBe('p1');
  });

  it('propagates axios failures', async () => {
    axios.get.mockRejectedValue(new Error('aws down'));
    await expect(fetchAWSEC2GPUPrices()).rejects.toThrow('aws down');
  });

  it('propagates errors on a malformed response (no products)', async () => {
    axios.get.mockResolvedValue({ data: {} });
    await expect(fetchAWSEC2GPUPrices()).rejects.toThrow();
  });
});

describe('fetchAzureGPUPrices', () => {
  it('returns an empty list (unimplemented provider)', async () => {
    await expect(fetchAzureGPUPrices()).resolves.toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
