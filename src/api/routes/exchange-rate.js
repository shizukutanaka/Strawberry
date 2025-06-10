// 為替レート・キャッシュ・取得時刻を返すREST APIルート
const express = require('express');
const router = express.Router();
const { getBTCtoJPYRate } = require('../../utils/exchange-rate');

// GET /api/exchange-rate
router.get('/', async (req, res) => {
  try {
    // ?fresh=true でキャッシュ無視
    const forceFresh = req.query.fresh === 'true';
    // { rate, timestamp } 形式で返す
    const { rate, timestamp, isCache } = await getBTCtoJPYRate(forceFresh, true);
    res.json({
      rate,
      timestamp,
      isCache: !!isCache
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
