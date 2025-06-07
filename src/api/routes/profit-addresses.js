// 運営利益受取アドレス管理API（Web管理UI用）
const express = require('express');
const router = express.Router();
const { getProfitAddresses, addProfitAddress, removeProfitAddress } = require('../utils/profit-addresses');

// 一覧取得
router.get('/', (req, res) => {
  try {
    const addrs = getProfitAddresses();
    res.json({ addresses: addrs });
  } catch (e) {
    res.status(500).json({ message: 'Failed to load addresses', error: e.message });
  }
});

// 追加
router.post('/', (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ message: 'address required' });
  try {
    addProfitAddress(address);
    res.json({ message: 'Added', address });
  } catch (e) {
    res.status(500).json({ message: 'Failed to add address', error: e.message });
  }
});

// 削除
router.delete('/', (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ message: 'address required' });
  try {
    removeProfitAddress(address);
    res.json({ message: 'Removed', address });
  } catch (e) {
    res.status(500).json({ message: 'Failed to remove address', error: e.message });
  }
});

module.exports = router;
