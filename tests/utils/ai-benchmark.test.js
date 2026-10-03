// src/utils/ai-benchmark.js — HuggingFace 推論呼出の契約を固定するテスト。
// API キー必須・Bearer 認証・SAFE_AXIOS_CONFIG 適用（timeout/上限/redirect 0）・
// エラー伝播は、無期限滞留・メモリ圧迫・キー無し送信のどれにも回帰できない不変条件。
jest.mock('axios');
const axios = require('axios');

const { runHuggingFaceInference, runAIBenchmark } = require('../../src/utils/ai-benchmark');

beforeEach(() => {
  axios.post.mockReset().mockResolvedValue({ status: 200, data: { out: 1 } });
});

describe('runHuggingFaceInference', () => {
  it('throws without an API key and makes no HTTP call', async () => {
    delete process.env.HF_API_KEY;
    await expect(runHuggingFaceInference('m', { x: 1 })).rejects.toThrow('APIキー未設定');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('posts to the HF inference endpoint with Bearer auth and safe axios config', async () => {
    await runHuggingFaceInference('model-1', { inputs: 'hi' }, { apiKey: 'hf-key' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://api-inference.huggingface.co/models/model-1',
      { inputs: 'hi' },
      expect.objectContaining({
        headers: { Authorization: 'Bearer hf-key' },
        timeout: 10_000,
        maxContentLength: 1_048_576,
        maxRedirects: 0,
      }),
    );
  });

  it('prefers options.apiKey over the HF_API_KEY env var', async () => {
    const saved = process.env.HF_API_KEY;
    process.env.HF_API_KEY = 'env-key';
    try {
      await runHuggingFaceInference('m', {}, { apiKey: 'opt-key' });
      expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer opt-key');
    } finally {
      if (saved === undefined) delete process.env.HF_API_KEY; else process.env.HF_API_KEY = saved;
    }
  });

  it('falls back to HF_API_KEY env when options.apiKey is absent', async () => {
    const saved = process.env.HF_API_KEY;
    process.env.HF_API_KEY = 'env-key';
    try {
      await runHuggingFaceInference('m', {});
      expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer env-key');
    } finally {
      if (saved === undefined) delete process.env.HF_API_KEY; else process.env.HF_API_KEY = saved;
    }
  });

  it('propagates axios failures', async () => {
    axios.post.mockRejectedValue(new Error('hf down'));
    await expect(runHuggingFaceInference('m', {}, { apiKey: 'k' })).rejects.toThrow('hf down');
  });
});

describe('runAIBenchmark', () => {
  it('delegates to the HF inference call with the same params', async () => {
    await runAIBenchmark('model-2', { p: 1 }, { apiKey: 'k' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://api-inference.huggingface.co/models/model-2',
      { p: 1 },
      expect.objectContaining({ headers: { Authorization: 'Bearer k' } }),
    );
  });
});
