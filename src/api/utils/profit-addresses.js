// 運営利益受取アドレス管理ユーティリティ（多重化＆ハッキング耐性）
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../../db/json/atomicWrite');
const { withLock } = require('../../utils/async-lock');
const { logger } = require('../../utils/logger');
// 従来 `../../data/...` は src/data/profit-addresses.json を指していた
// （__dirname = src/api/utils から2階層上は src/）。src/data/ に格納すると
// git 追跡済みの同梱プレースホルダが出荷され、新規デプロイで例示アドレスが
// 実送金先として選択され得た（BIP-173 例示アドレスは BTC パターンを通過する）。
// 他リポジトリ同様、ランタイムデータはリポジトリルートの data/ に置く。
const ADDR_FILE = path.join(__dirname, '../../../data/profit-addresses.json');
// 移行元（旧バグパス）。残っている場合のみ内容を引き継ぐ。
const LEGACY_ADDR_FILE = path.join(__dirname, '../../data/profit-addresses.json');
// リポジトリにコミットされていたプレースホルダ（ダミー + BIP-173 例示アドレス）。
// 例示アドレス宛の送金は事実上のバーンで資金喪失になるため、移行時に引き継がない。
const BUNDLED_SEED_ADDRESSES = new Set([
  'bc1qoperatoridem0000000000000000000000',
  'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
]);

// 並行 add/remove で list 全体を read-modify-write しているため、
// 並行 remove(攻撃者旧アドレス) + add(正規新アドレス) が、片方の読み込んだ古い
// snapshot で上書きされて削除済み攻撃者アドレスを蘇らせる lost-update が成立する。
// → 運営手数料の送金先がすり替わる。プロセス内 mutex で直列化する。
const ADDR_LOCK = 'profit-addresses:global';

// BTC アドレスの構文検証（資金喪失防止）。
// payout 先は実際の送金対象であり、誤った文字列を保存すると sendBTC の瞬間まで
// 誤りが露見せず不可逆な損失につながる。mainnet/testnet/regtest の
// 主要形式（P2PKH/P2SH の Base58、Bech32(bc1/tb1/bcrt1)）を許容する。
const BTC_ADDRESS_PATTERNS = [
  /^[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/,      // mainnet P2PKH / P2SH (Base58)
  /^[2mn][a-km-zA-HJ-NP-Z1-9]{25,39}$/,     // testnet P2PKH / P2SH (Base58)
  /^bc1[a-z0-9]{11,87}$/,                    // mainnet Bech32 / Bech32m
  /^tb1[a-z0-9]{11,87}$/,                    // testnet Bech32 / Bech32m
  /^bcrt1[a-z0-9]{11,87}$/,                  // regtest Bech32
];

function isValidBtcAddress(address) {
  if (typeof address !== 'string') return false;
  const a = address.trim();
  if (a.length < 14 || a.length > 100) return false;
  return BTC_ADDRESS_PATTERNS.some((re) => re.test(a));
}

// 初期化：ディレクトリ・ファイルがなければ作成。
// 旧パス（src/data/）に実データが残る環境では、同梱シードを除外して一度だけ移行する。
if (!fs.existsSync(ADDR_FILE)) {
  fs.mkdirSync(path.dirname(ADDR_FILE), { recursive: true });
  let migrated = [];
  if (fs.existsSync(LEGACY_ADDR_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_ADDR_FILE));
      if (Array.isArray(legacy)) {
        const dropped = legacy.length;
        migrated = legacy.filter(a => !BUNDLED_SEED_ADDRESSES.has(a));
        if (migrated.length !== dropped) {
          logger.warn(`profit-addresses: dropped ${dropped - migrated.length} bundled seed address(es) during migration`);
        }
      }
    } catch (e) {
      logger.warn(`profit-addresses: legacy store unreadable, starting empty: ${e.message}`);
    }
  }
  atomicWriteJSON(ADDR_FILE, migrated);
}

function getProfitAddresses() {
  try {
    const arr = JSON.parse(fs.readFileSync(ADDR_FILE));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

async function addProfitAddress(address) {
  // fail-fast: 無効なアドレスは保存させない（全呼び出し経路を保護）
  const a = typeof address === 'string' ? address.trim() : address;
  if (!isValidBtcAddress(a)) {
    throw new Error('Invalid Bitcoin address');
  }
  await withLock(ADDR_LOCK, async () => {
    const arr = getProfitAddresses();
    if (!arr.includes(a)) {
      arr.push(a);
      atomicWriteJSON(ADDR_FILE, arr);
    }
  });
}

async function removeProfitAddress(address) {
  await withLock(ADDR_LOCK, async () => {
    const arr = getProfitAddresses().filter(a => a !== address);
    atomicWriteJSON(ADDR_FILE, arr);
  });
}

// 利益分配先をランダム/ラウンドロビンで選択（攻撃耐性向上）
let lastIdx = 0;
function selectProfitAddress() {
  const arr = getProfitAddresses();
  if (arr.length === 0) throw new Error('No profit addresses registered');
  // 出口での気づき: 過去に検証なしで保存された不正アドレスを送金直前に検知し警告する。
  const valid = arr.filter(isValidBtcAddress);
  if (valid.length === 0) {
    throw new Error('No valid profit addresses registered');
  }
  if (valid.length !== arr.length) {
    logger.warn(`profit-addresses: ${arr.length - valid.length} stored address(es) are invalid and will be skipped`);
  }
  // ラウンドロビン選択（有効アドレスのみ）
  lastIdx = (lastIdx + 1) % valid.length;
  return valid[lastIdx];
}

module.exports = {
  getProfitAddresses,
  addProfitAddress,
  removeProfitAddress,
  selectProfitAddress,
  isValidBtcAddress,
  // テスト用フック: ストアパスの回帰検証（timingSafeStrEqual/_isSSRFUrl と同型）
  _ADDR_FILE: ADDR_FILE,
  _LEGACY_ADDR_FILE: LEGACY_ADDR_FILE,
  _BUNDLED_SEED_ADDRESSES: BUNDLED_SEED_ADDRESSES
};
