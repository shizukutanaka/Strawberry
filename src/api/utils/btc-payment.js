// BTC支払い最適化・利益自動控除ユーティリティ
const FEE_RATE = parseFloat(process.env.BTC_FEE_RATE || '0.015');

// 支払総額（借り手→運営）を計算
function calcTotalWithFee(amount) {
  return Math.round(amount * (1 + FEE_RATE) * 1e8) / 1e8; // Satoshi精度
}

// 運営利益額を計算
function calcFee(amount) {
  return Math.round(amount * FEE_RATE * 1e8) / 1e8;
}

// 貸し手への送金額（純額）
function calcPayout(amount) {
  return Math.round(amount * 1e8) / 1e8;
}

// 利益送金先管理ユーティリティ
const { selectProfitAddress } = require('./profit-addresses');

// Lightning Network外部APIラッパー
const { sendLightningPayment } = require('./lightning-api');

// Lightning Network経由でBTC送金（OpenNode/LNbits/BTCPay等）
async function sendBTC(fromWallet, toWallet, amount) {
  try {
    // fromWalletは実際にはLNウォレット管理のため使わない場合もあり
    const result = await sendLightningPayment(toWallet, amount);
    return { txid: result.id || result.payment_hash || 'ln-tx', amount, from: fromWallet, to: toWallet };
  } catch (err) {
    // fallback: ダミー送金（開発・テスト用）
    console.log(`[LN Fallback] Send ${amount} BTC from ${fromWallet} to ${toWallet}`);
    return { txid: 'dummy-txid', amount, from: fromWallet, to: toWallet, error: err.message };
  }
}

// 利益送金先アドレスを取得（ラウンドロビン/ランダムで分散）
function getOperatorWallet() {
  return selectProfitAddress();
}

module.exports = {
  FEE_RATE,
  calcTotalWithFee,
  calcFee,
  calcPayout,
  sendBTC,
  getOperatorWallet
};
