// src/api/middleware/audit.js - 監査ログミドルウェア
const fs = require('fs');
const path = require('path');
const { sanitizeSensitiveFields } = require('../../utils/sanitize');
// HTTP リクエスト監査の出力先。
// 重要: 改ざん検知ハッシュチェーン(src/utils/audit-log.js)が管理する logs/audit.log とは
// 別ファイルにする。同一ファイルへ追記すると、ハッシュチェーンに含まれない本ミドルウェアの
// エントリが間に挟まり、verifyAuditLogIntegrity / audit-anchor の検証が常に失敗していた。
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(__dirname, '../../../logs/access-audit.log');

// 巨大な body/query/response（一覧取得やファイル内容等）を全文記録すると
// 監査ログが急膨張し、JSON.stringify + 再帰マスキング自体もリクエスト処理の
// ボトルネックになるため、記録するフィールドサイズに上限を設ける。
const MAX_LOGGED_FIELD_BYTES = 2048;

// 上限内ならマスク済みオブジェクト、超過なら内容を捨ててサイズのみ記録する。
function capForLog(value) {
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch (e) {
    return '[unserializable]';
  }
  if (raw === undefined) return undefined;
  if (raw.length > MAX_LOGGED_FIELD_BYTES) {
    return { _truncated: true, bytes: raw.length };
  }
  return sanitizeSensitiveFields(value);
}

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
    // 機密情報はマスキング（query も token/apiKey 等が混入し得るためマスクする）
    body: req.method !== 'GET' ? capForLog(req.body) : undefined,
    query: capForLog(req.query),
    status: null,
    durationMs: null,
    error: null
  };

  const originalJson = res.json;
  res.json = function (data) {
    logEntry.status = res.statusCode;
    logEntry.durationMs = Date.now() - start;
    // レスポンスもマスキング
    logEntry.response = capForLog(data);
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

// mkdirSync は初回のみ（リクエスト毎に mkdir syscall を打つ必要はない）。
let _logDirReady = false;
function writeAuditLog(entry) {
  try {
    if (!_logDirReady) {
      fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
      _logDirReady = true;
    }
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {
    // ログ失敗時はサイレント
  }
}

module.exports = auditLogger;
