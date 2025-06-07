// Lightning Network対応の外部決済APIラッパー（例: OpenNode, LNbits, BTCPay Server）
const axios = require('axios');

// 環境変数でAPIキーやエンドポイントを管理
const PROVIDER = process.env.LN_PROVIDER || 'opennode'; // 'opennode', 'lnbits', 'btcpay'
const API_KEY = process.env.LN_API_KEY || '';
const BASE_URL = process.env.LN_BASE_URL || '';

// --- OpenNode例 ---
async function sendPaymentOpenNode(dest, amountBTC) {
  // OpenNodeはsats単位
  const amountSats = Math.round(amountBTC * 1e8);
  const res = await axios.post(
    BASE_URL + '/v2/withdrawals',
    {
      type: 'chain',
      address: dest,
      amount: amountSats
    },
    {
      headers: { 'Authorization': API_KEY }
    }
  );
  return res.data;
}

// --- LNbits例 ---
async function sendPaymentLNbits(dest, amountBTC) {
  // LNbitsはAPI仕様が異なる場合あり
  const amountSats = Math.round(amountBTC * 1e8);
  const res = await axios.post(
    BASE_URL + '/api/v1/payments',
    {
      out: true,
      bolt11: dest, // Invoice形式
      amount: amountSats
    },
    {
      headers: { 'X-Api-Key': API_KEY }
    }
  );
  return res.data;
}

// --- 汎用 ---
async function sendLightningPayment(dest, amountBTC) {
  if (PROVIDER === 'opennode') return sendPaymentOpenNode(dest, amountBTC);
  if (PROVIDER === 'lnbits') return sendPaymentLNbits(dest, amountBTC);
  throw new Error('Unsupported LN provider');
}

module.exports = {
  sendLightningPayment
};
