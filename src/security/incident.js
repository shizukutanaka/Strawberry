// セキュリティインシデント検知・通知・証跡管理ユーティリティ雛形
const path = require('path');
const { recordComplianceEvent } = require('./compliance');
const { appendRotated, ensureLogDir } = require('../utils/log-rotate');
const INCIDENT_LOG_PATH = path.resolve(__dirname, '../../logs/security-incident.log');

function recordIncident(type, detail) {
  try {
    ensureLogDir(INCIDENT_LOG_PATH);
    const entry = { timestamp: new Date().toISOString(), type, detail };
    appendRotated(INCIDENT_LOG_PATH, JSON.stringify(entry) + '\n');
    recordComplianceEvent('security_incident', { type, detail });
  } catch (e) {/* ログ失敗時はサイレント */}
}

// 例: インシデント発生時の通知（Slack等）
async function notifyIncident(type, detail, notifier) {
  recordIncident(type, detail);
  if (notifier) {
    try {
      await notifier.send(`[SECURITY INCIDENT] ${type}: ${JSON.stringify(detail)}`);
    } catch (e) {/* 通知失敗時はサイレント */}
  }
}

module.exports = { recordIncident, notifyIncident };
