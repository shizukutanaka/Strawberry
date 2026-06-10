// 運営利益受取アドレス管理ユーティリティ（多重化＆ハッキング耐性）
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../../db/json/atomicWrite');
const ADDR_FILE = path.join(__dirname, '../../data/profit-addresses.json');

// 初期化：ディレクトリ・ファイルがなければ作成
if (!fs.existsSync(ADDR_FILE)) {
  fs.mkdirSync(path.dirname(ADDR_FILE), { recursive: true });
  atomicWriteJSON(ADDR_FILE, []);
}

function getProfitAddresses() {
  try {
    const arr = JSON.parse(fs.readFileSync(ADDR_FILE));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function addProfitAddress(address) {
  const arr = getProfitAddresses();
  if (!arr.includes(address)) {
    arr.push(address);
    atomicWriteJSON(ADDR_FILE, arr);
  }
}

function removeProfitAddress(address) {
  const arr = getProfitAddresses().filter(a => a !== address);
  atomicWriteJSON(ADDR_FILE, arr);
}

// 利益分配先をランダム/ラウンドロビンで選択（攻撃耐性向上）
let lastIdx = 0;
function selectProfitAddress() {
  const arr = getProfitAddresses();
  if (arr.length === 0) throw new Error('No profit addresses registered');
  // ランダム or ラウンドロビン選択（ここではラウンドロビン）
  lastIdx = (lastIdx + 1) % arr.length;
  return arr[lastIdx];
}

module.exports = {
  getProfitAddresses,
  addProfitAddress,
  removeProfitAddress,
  selectProfitAddress
};
