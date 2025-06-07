// BTC/JPY為替レート取得ユーティリティの単体テスト
const { getBTCtoJPYRate } = require('../../src/utils/exchange-rate');
const assert = require('assert');

describe('getBTCtoJPYRate', function() {
  this.timeout(15000); // 外部APIなので余裕を持たせる

  it('should return a number in valid BTC/JPY range', async () => {
    const rate = await getBTCtoJPYRate();
    assert.strictEqual(typeof rate, 'number');
    assert(!isNaN(rate));
    assert(rate > 100000 && rate < 15000000);
  });

  it('should use cache when called repeatedly', async () => {
    const rate1 = await getBTCtoJPYRate();
    const rate2 = await getBTCtoJPYRate();
    assert.strictEqual(rate1, rate2);
  });

  it('should throw on all API failures (simulate)', async () => {
    // APIを強制的に壊す
    const origApis = require('../../src/utils/exchange-rate').apis;
    require('../../src/utils/exchange-rate').apis = [async () => { throw new Error('dummy error'); }];
    try {
      await getBTCtoJPYRate(true);
      assert.fail('Should have thrown');
    } catch (err) {
      assert(err.message.includes('dummy error') || err.message.includes('取得失敗'));
    } finally {
      require('../../src/utils/exchange-rate').apis = origApis;
    }
  });
});
