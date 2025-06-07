// SLA（稼働率保証）自動集計・表示ユーティリティ
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { resilientNotify } = require('./resilient-notify');

const SLA_PATH = path.join(__dirname, '../../data/sla.json');
const CHECK_INTERVAL = 60 * 1000; // 1分

function loadSLA() {
  if (!fs.existsSync(SLA_PATH)) return { total: 0, up: 0, down: 0, history: [] };
  return JSON.parse(fs.readFileSync(SLA_PATH, 'utf-8'));
}
function saveSLA(sla) {
  fs.writeFileSync(SLA_PATH, JSON.stringify(sla, null, 2));
}

async function checkAlive() {
  // HTTP/DB/主要プロセス等の死活監視（ここではHTTP 200を簡易例）
  try {
    const res = await fetch('http://localhost:3000/health');
    return res.ok;
  } catch {
    return false;
  }
}

async function updateSLA() {
  const sla = loadSLA();
  sla.total++;
  const alive = await checkAlive();
  if (alive) sla.up++;
  else sla.down++;
  sla.history.push({ time: new Date().toISOString(), alive });
  if (sla.history.length > 1440) sla.history.shift(); // 1日分だけ保持
  saveSLA(sla);
  if (!alive) {
    logger.warn('[SLA] 死活監視NG');
    await resilientNotify('[Strawberry] 死活監視NG: サービスが応答しません');
  }
}

function getSLAStats() {
  const sla = loadSLA();
  const rate = sla.total ? (sla.up / sla.total) : 1;
  return { uptimeRate: rate, up: sla.up, total: sla.total, down: sla.down };
}

function startSLATracker() {
  setInterval(updateSLA, CHECK_INTERVAL);
}

module.exports = { startSLATracker, getSLAStats, updateSLA };
