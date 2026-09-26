// profit-addresses ストアパスの回帰テスト
// バグ: path.join(__dirname, '../../data/...') は src/api/utils から見て
// src/data/ を指していた。ランタイムデータはリポジトリルートの data/ に置く
// 規約に反していた（他の JSON ストアと同じ場所に揃える）。
// さらに同梱シード（BIP-173 例示アドレス等）が移行で引き継がれないことを検証。
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');

describe('profit-addresses store location', () => {
  it('ADDR_FILE はリポジトリルートの data/ を指す（src/data ではない）', () => {
    const { _ADDR_FILE } = require('../../src/api/utils/profit-addresses');
    expect(_ADDR_FILE).toBe(path.join(REPO_ROOT, 'data', 'profit-addresses.json'));
    expect(_ADDR_FILE.includes(`${path.sep}src${path.sep}`)).toBe(false);
  });

  it('移行元 LEGACY_ADDR_FILE は旧バグパス src/data/ を指す', () => {
    const { _LEGACY_ADDR_FILE } = require('../../src/api/utils/profit-addresses');
    expect(_LEGACY_ADDR_FILE).toBe(
      path.join(REPO_ROOT, 'src', 'data', 'profit-addresses.json')
    );
  });

  it('同梱シード（BIP-173 例示アドレス）は移行対象から除外される', () => {
    const { _BUNDLED_SEED_ADDRESSES } = require('../../src/api/utils/profit-addresses');
    // BIP-173 の例示 Bech32 アドレス — BTC 正規表現を通過するが実送金先ではない
    expect(_BUNDLED_SEED_ADDRESSES.has('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(_BUNDLED_SEED_ADDRESSES.size).toBe(2);
  });

  it('レガシーファイルからの移行はシードを落として正規アドレスのみ保持する', () => {
    // 初期化ブロックが一度だけ走る前提で、モジュール再読込＋ファイル配置で検証する。
    const { _ADDR_FILE, _LEGACY_ADDR_FILE, _BUNDLED_SEED_ADDRESSES } =
      require('../../src/api/utils/profit-addresses');
    const validAddr = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'; // BIP-173 別例
    jest.resetModules();
    // 新規側を消し、レガシーに シード+実アドレス を置いて再読込 → 移行結果を確認
    if (fs.existsSync(_ADDR_FILE)) fs.rmSync(_ADDR_FILE);
    fs.mkdirSync(path.dirname(_LEGACY_ADDR_FILE), { recursive: true });
    fs.writeFileSync(
      _LEGACY_ADDR_FILE,
      JSON.stringify([..._BUNDLED_SEED_ADDRESSES, validAddr])
    );
    try {
      const mod = require('../../src/api/utils/profit-addresses');
      const stored = mod.getProfitAddresses();
      expect(stored).toEqual([validAddr]);
      for (const seed of _BUNDLED_SEED_ADDRESSES) {
        expect(stored).not.toContain(seed);
      }
    } finally {
      // 後片付け: 作成した両ファイルを除去してクリーンに戻す
      if (fs.existsSync(_LEGACY_ADDR_FILE)) fs.rmSync(_LEGACY_ADDR_FILE);
      if (fs.existsSync(_ADDR_FILE)) fs.rmSync(_ADDR_FILE);
      jest.resetModules();
    }
  });
});
