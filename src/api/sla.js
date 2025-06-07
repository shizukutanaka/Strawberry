// SLA・障害履歴ダッシュボードAPI
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const SLA_PATH = path.join(__dirname, '../../data/sla.json');
const ANOMALY_HISTORY_PATH = path.join(__dirname, '../../logs/anomaly-history.json');

// SLA統計取得API
router.get('/sla', (req, res) => {
  if (!fs.existsSync(SLA_PATH)) return res.json({ uptimeRate: 1, up: 0, down: 0, total: 0 });
  const sla = JSON.parse(fs.readFileSync(SLA_PATH, 'utf-8'));
  const rate = sla.total ? (sla.up / sla.total) : 1;
  res.json({ uptimeRate: rate, up: sla.up, down: sla.down, total: sla.total });
});

// 障害履歴取得API
router.get('/anomalies', (req, res) => {
  if (!fs.existsSync(ANOMALY_HISTORY_PATH)) return res.json([]);
  const history = JSON.parse(fs.readFileSync(ANOMALY_HISTORY_PATH, 'utf-8'));
  res.json(history.slice(-100).reverse()); // 直近100件のみ返す
});

module.exports = { router };
