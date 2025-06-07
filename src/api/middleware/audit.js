// src/api/middleware/audit.js - 監査ログミドルウェア
const fs = require('fs');
const path = require('path');
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../../logs/audit.log');

function auditLogger(req, res, next) {
  const start = Date.now();
  const user = req.user || {};
  const peerId = user.peerId || null;
  const logEntry = {
    time: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl,
    userId: user.id || null,
    peerId,
    ip: req.ip,
    // 機密情報はマスキング
    body: req.method !== 'GET' ? require('../../utils/sanitize').sanitizeSensitiveFields(req.body) : undefined,
    query: req.query,
    status: null,
    durationMs: null,
    error: null
  };

  const originalJson = res.json;
  res.json = function (data) {
    logEntry.status = res.statusCode;
    logEntry.durationMs = Date.now() - start;
    // レスポンスもマスキング
    logEntry.response = require('../../utils/sanitize').sanitizeSensitiveFields(data);
    writeAuditLog(logEntry);
    return originalJson.apply(this, arguments);
  };

  res.on('finish', () => {
    if (logEntry.status === null) {
      logEntry.status = res.statusCode;
      logEntry.durationMs = Date.now() - start;
      writeAuditLog(logEntry);
    }
  });

  next();
}

function writeAuditLog(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    // ログ失敗時はサイレント
  }
}

module.exports = auditLogger;
