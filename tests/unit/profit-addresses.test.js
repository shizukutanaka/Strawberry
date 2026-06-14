// 運営利益受取アドレスの構文検証テスト（資金喪失防止）
const {
  isValidBtcAddress,
  addProfitAddress,
} = require('../../src/api/utils/profit-addresses');

describe('profit-addresses: isValidBtcAddress', () => {
  it('accepts valid mainnet/testnet BTC addresses', () => {
    expect(isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true); // P2PKH
    expect(isValidBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true); // P2SH
    expect(isValidBtcAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true); // bech32
    expect(isValidBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(true); // testnet
  });

  it('rejects non-addresses and garbage', () => {
    expect(isValidBtcAddress('my-wallet')).toBe(false);
    expect(isValidBtcAddress('')).toBe(false);
    expect(isValidBtcAddress('0xabc123')).toBe(false);
    expect(isValidBtcAddress('bc1!!!invalid')).toBe(false);
    expect(isValidBtcAddress(null)).toBe(false);
    expect(isValidBtcAddress(12345)).toBe(false);
  });

  it('addProfitAddress throws on an invalid address (fail-fast)', () => {
    expect(() => addProfitAddress('not-a-btc-address')).toThrow(/Invalid Bitcoin address/);
  });
});
