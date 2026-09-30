// tests/unit/btc-payment.test.js
// src/api/utils/btc-payment.js の単体テスト。
// 送金経路の金額計算（手数料・Satoshi丸め）と sendBTC の
// 「失敗時にダミーtxidを成功として返さない」不変条件を検証する。

jest.mock('../../src/api/utils/lightning-api', () => ({
  sendLightningPayment: jest.fn(),
}));
jest.mock('../../src/api/utils/profit-addresses', () => ({
  selectProfitAddress: jest.fn(() => 'bc1qoperator'),
}));

// モジュールはトップレベルで BTC_FEE_RATE を検証するため、
// env を変えて毎回モジュールレジストリをリセットして読み込む。
// resetModules 後にモックを再 require することでテスト側と被検モジュール側が
// 同一の jest.fn インスタンスを共有する。
function fresh() {
  jest.resetModules();
  return {
    btc: require('../../src/api/utils/btc-payment'),
    sendLightningPayment: require('../../src/api/utils/lightning-api').sendLightningPayment,
    selectProfitAddress: require('../../src/api/utils/profit-addresses').selectProfitAddress,
  };
}

describe('btc-payment', () => {
  const OLD = process.env.BTC_FEE_RATE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.BTC_FEE_RATE;
    else process.env.BTC_FEE_RATE = OLD;
  });

  describe('FEE_RATE validation', () => {
    it('uses default 0.015 when BTC_FEE_RATE is unset', () => {
      delete process.env.BTC_FEE_RATE;
      expect(fresh().btc.FEE_RATE).toBe(0.015);
    });

    it('accepts a valid rate from env', () => {
      process.env.BTC_FEE_RATE = '0.02';
      expect(fresh().btc.FEE_RATE).toBe(0.02);
    });

    it.each(['abc', '-0.5', '1', '1.5', 'NaN', 'Infinity'])(
      'throws on invalid BTC_FEE_RATE=%s (fail-fast at load)',
      (v) => {
        process.env.BTC_FEE_RATE = v;
        expect(() => fresh()).toThrow(/Invalid BTC_FEE_RATE/);
      }
    );
  });

  describe('fee math (satoshi precision)', () => {
    beforeEach(() => { delete process.env.BTC_FEE_RATE; });

    it('calcTotalWithFee applies the fee and rounds to satoshi precision', () => {
      const { btc } = fresh();
      // 0.001 BTC + 1.5% = 0.001015 BTC
      expect(btc.calcTotalWithFee(0.001)).toBeCloseTo(0.001015, 10);
      // 丸め確認: 結果は 1e-8 (1 satoshi) の整数倍
      const v = btc.calcTotalWithFee(1 / 3);
      expect(Math.abs(v * 1e8 - Math.round(v * 1e8))).toBeLessThan(1e-6);
    });

    it('calcFee returns the operator share with satoshi precision', () => {
      const { btc } = fresh();
      expect(btc.calcFee(0.001)).toBeCloseTo(0.000015, 10);
      const v = btc.calcFee(1 / 3);
      expect(Math.abs(v * 1e8 - Math.round(v * 1e8))).toBeLessThan(1e-6);
    });

    it('calcPayout returns the net amount unchanged', () => {
      expect(fresh().btc.calcPayout(0.001)).toBe(0.001);
    });

    it('total = payout + fee within satoshi tolerance', () => {
      const { btc } = fresh();
      for (const amt of [0.001, 1 / 3, 0.00000001, 2.5]) {
        const diff = Math.abs(btc.calcTotalWithFee(amt) - btc.calcPayout(amt) - btc.calcFee(amt));
        expect(diff).toBeLessThan(2e-8);
      }
    });
  });

  describe('sendBTC', () => {
    beforeEach(() => { delete process.env.BTC_FEE_RATE; });

    it('returns txid when the Lightning API returns an id', async () => {
      const { btc, sendLightningPayment } = fresh();
      sendLightningPayment.mockResolvedValue({ id: 'tx_abc123' });
      const r = await btc.sendBTC('from', 'to', 0.001);
      expect(r).toMatchObject({ txid: 'tx_abc123', amount: 0.001, from: 'from', to: 'to' });
      expect(sendLightningPayment).toHaveBeenCalledWith('to', 0.001);
    });

    it('accepts payment_hash as txid', async () => {
      const { btc, sendLightningPayment } = fresh();
      sendLightningPayment.mockResolvedValue({ payment_hash: 'hash_xyz' });
      const r = await btc.sendBTC('from', 'to', 0.001);
      expect(r.txid).toBe('hash_xyz');
    });

    it.each([
      ['empty object', {}],
      ['null', null],
      ['empty string id', { id: '' }],
    ])('throws instead of returning a dummy txid when result is %s', async (_label, bad) => {
      const { btc, sendLightningPayment } = fresh();
      sendLightningPayment.mockResolvedValue(bad);
      // 資金安全の不変条件: 失敗時にダミー txid を「成功」として返してはならない。
      // 返り値に txid が無い場合は必ず例外へ（呼出側が決済を成功記録しないため）。
      await expect(btc.sendBTC('from', 'to', 0.001))
        .rejects.toThrow('transaction id');
    });

    it('propagates Lightning API failures as exceptions', async () => {
      const { btc, sendLightningPayment } = fresh();
      sendLightningPayment.mockRejectedValue(new Error('upstream 502'));
      await expect(btc.sendBTC('from', 'to', 0.001)).rejects.toThrow('upstream 502');
    });
  });

  describe('getOperatorWallet', () => {
    it('delegates to selectProfitAddress', () => {
      delete process.env.BTC_FEE_RATE;
      const { btc, selectProfitAddress } = fresh();
      expect(btc.getOperatorWallet()).toBe('bc1qoperator');
      expect(selectProfitAddress).toHaveBeenCalled();
    });
  });
});
