// src/api/middleware/audit.js - 監査ログミドルウェア
const fs = require('fs');
const path = require('path');
const { sanitizeSensitiveFields } = require('../../utils/sanitize');
// HTTP リクエスト監査の出力先。
// 重要: 改ざん検知ハッシュチェーン(src/utils/audit-log.js)が管理する logs/audit.log とは
// 別ファイルにする。同一ファイルへ追記すると、ハッシュチェーンに含まれない本ミドルウェアの
// エントリが間に挟まり、verifyAuditLogIntegrity / audit-anchor の検証が常に失敗していた。
//
// 環境変数も別にする必要がある: 旧実装は上の警告に反して `AUDIT_LOG_PATH`（audit-log.js が
// ハッシュチェーン付きログの移動に使う変数）を共用していたため、運用者がその変数を設定した
// 瞬間に両者が同一ファイルへ書き込み、まさにこのコメントが警告するチェーン破壊が再発する
// 状態だった。アクセス監査の移動には専用の ACCESS_AUDIT_LOG_PATH を使う。
const AUDIT_LOG_PATH = process.env.ACCESS_AUDIT_LOG_PATH
  || path.join(__dirname, '../../../logs/access-audit.log');

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
    body: req.method !== 'GET' ? sanitizeSensitiveFields(req.body) : undefined,
    query: sanitizeSensitiveFields(req.query),
    status: null,
    durationMs: null,
    error: null
  };

  const originalJson = res.json;
  res.json = function (data) {
    logEntry.status = res.statusCode;
    logEntry.durationMs = Date.now() - start;
    // レスポンスもマスキング
    logEntry.response = sanitizeSensitiveFields(data);
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
