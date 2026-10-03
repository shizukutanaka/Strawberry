// src/api/utils/lightning-api.js — Lightning REST プロバイダラッパーの契約を固定するテスト。
// 資金移動経路: プロバイダ振分け・sat 変換・認証ヘッダー・SAFE_AXIOS_CONFIG 適用は
// 誤送金・滞留・SSRF 防御解除のどれにも回帰できない不変条件。
// モジュールは require 時に env を読むため resetModules 後に require する。
// 注意: resetModules 後は require('axios') が新モックインスタンスを返すため、
// トップレベルの import ではなく setup 内で取得した同一インスタンスを検証に使う。
jest.mock('axios');

const SAVED = {};
function setEnv(k, v) { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; }
function restoreAll() {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    delete SAVED[k];
  }
}

function setup(provider = 'opennode') {
  jest.resetModules();
  const ax = require('axios'); // resetModules 後の同一モックインスタンス
  setEnv('LN_PROVIDER', provider);
  setEnv('LN_API_KEY', 'key-123');
  setEnv('LN_BASE_URL', 'https://ln.example.com');
  ax.post.mockResolvedValue({ data: { ok: true } });
  const api = require('../../src/api/utils/lightning-api');
  return { api, ax };
}

afterEach(restoreAll);

describe('sendLightningPayment — OpenNode', () => {
  it('posts a chain withdrawal with sats conversion and auth header', async () => {
    const { api, ax } = setup('opennode');
    await api.sendLightningPayment('bc1qaddr', 0.00001111);
    expect(ax.post).toHaveBeenCalledWith(
      'https://ln.example.com/v2/withdrawals',
      { type: 'chain', address: 'bc1qaddr', amount: 1111 }, // BTC → sats (Math.round)
      expect.objectContaining({ headers: { 'Authorization': 'key-123' } }),
    );
  });

  it('applies SAFE_AXIOS_CONFIG (timeout / body cap / no redirects)', async () => {
    const { api, ax } = setup('opennode');
    await api.sendLightningPayment('dest', 0.001);
    const cfg = ax.post.mock.calls[0][2];
    expect(cfg.timeout).toBe(10_000);
    expect(cfg.maxContentLength).toBe(1_048_576);
    expect(cfg.maxRedirects).toBe(0);
  });
});

describe('sendLightningPayment — LNbits', () => {
  it('posts an outgoing payment with X-Api-Key header', async () => {
    const { api, ax } = setup('lnbits');
    await api.sendLightningPayment('lnbc...', 0.00002);
    expect(ax.post).toHaveBeenCalledWith(
      'https://ln.example.com/api/v1/payments',
      { out: true, bolt11: 'lnbc...', amount: 2000 },
      expect.objectContaining({ headers: { 'X-Api-Key': 'key-123' } }),
    );
  });
});

describe('sendLightningPayment — dispatch', () => {
  it('throws for an unsupported provider (fail-closed)', async () => {
    const { api, ax } = setup('btcpay');
    await expect(api.sendLightningPayment('dest', 0.001)).rejects.toThrow('Unsupported LN provider');
    expect(ax.post).not.toHaveBeenCalled();
  });

  it('propagates axios failures', async () => {
    const { api, ax } = setup('opennode');
    ax.post.mockRejectedValue(new Error('network'));
    await expect(api.sendLightningPayment('dest', 0.001)).rejects.toThrow('network');
  });
});
