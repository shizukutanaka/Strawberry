// 運営利益受取アドレス管理API（Web管理UI用）
const express = require('express');
const router = express.Router();
const { getProfitAddresses, addProfitAddress, removeProfitAddress, isValidBtcAddress } = require('../utils/profit-addresses');
const jwtAuth = require('../middleware/jwt-auth');
const rbac = require('../middleware/rbac');
const { masterSession } = require('../middleware/master-session');
const { requireMasterAuth } = require('./master-auth');
const { logger } = require('../../utils/logger');

// 運営利益受取アドレスは資金フローに直結するため、認証(JWT) + 管理者ロール(admin) に加え、
// Google OAuth→TOTP→メール の3段階認証（/master-auth/* で完了済みのセッション）も必須とする。
// requireMasterAuth は req.session.masterAuth を見るため、master-auth.js の
// /master-auth/* ルートと同一の session ミドルウェアインスタンス（masterSession）を
// ここでも通す必要がある（さもないと req.session が undefined になり必ず 403 になる）。
router.use(masterSession);
router.use(jwtAuth);
router.use(rbac('admin'));
router.use(requireMasterAuth);

const maskError = (e, msg) => {
  logger.error(msg, e);
  return process.env.NODE_ENV === 'production' ? msg : e.message;
};

// 一覧取得
router.get('/', (req, res) => {
  try {
    const addrs = getProfitAddresses();
    res.json({ addresses: addrs });
  } catch (e) {
    res.status(500).json({ message: 'Failed to load addresses', error: maskError(e, 'Failed to load addresses') });
  }
});

// 追加
router.post('/', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ message: 'address required' });
  // 多層防御: ルート層でも構文検証し、無効入力は 400 で明確に拒否する
  // （ユーティリティの fail-fast を 500 ではなくクライアントエラーとして返す）。
  if (!isValidBtcAddress(address)) {
    return res.status(400).json({ message: 'Invalid Bitcoin address' });
  }
  try {
    await addProfitAddress(address);
    res.json({ message: 'Added', address: String(address).trim() });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add address', error: maskError(e, 'Failed to add address') });
  }
});

// 削除
router.delete('/', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ message: 'address required' });
  // POST と対称に DELETE でも構文検証: 攻撃者がパスを通る address="__proto__" 等の
  // 異常値で removeProfitAddress を呼び出せないようにする。
  if (!isValidBtcAddress(address)) {
    return res.status(400).json({ message: 'Invalid Bitcoin address' });
  }
  try {
    await removeProfitAddress(address);
    res.json({ message: 'Removed', address: String(address).trim() });
  } catch (e) {
    res.status(500).json({ message: 'Failed to remove address', error: maskError(e, 'Failed to remove address') });
  }
});

module.exports = router;
