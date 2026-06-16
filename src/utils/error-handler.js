// src/utils/error-handler.js - エラーハンドリングユーティリティ
const { logger } = require('./logger');

// エラータイプの定義
const ErrorTypes = {
  INTERNAL: 'INTERNAL_ERROR',
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED_ERROR',
  FORBIDDEN: 'FORBIDDEN_ERROR',
  CONFLICT: 'CONFLICT_ERROR',
  EXTERNAL_SERVICE: 'EXTERNAL_SERVICE_ERROR',
  GPU_ERROR: 'GPU_ERROR',
  P2P_ERROR: 'P2P_ERROR',
  LIGHTNING_ERROR: 'LIGHTNING_ERROR',
  PAYMENT_ERROR: 'PAYMENT_ERROR'
};

// APIエラークラス
class APIError extends Error {
  constructor(type, message, statusCode = 500, details = null) {
    super(message);
    this.name = 'APIError';
    this.type = type;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    
    // スタックトレースを保持
    Error.captureStackTrace(this, this.constructor);
  }
  
  // エラーレスポンス用のJSONオブジェクトを生成
  // maskInternal=true（本番）では 5xx の詳細をクライアントに漏らさない
  toJSON(maskInternal = false) {
    const masked = maskInternal && this.statusCode >= 500;
    return {
      error: {
        type: this.type,
        message: masked ? 'Internal server error' : this.message,
        statusCode: this.statusCode,
        timestamp: this.timestamp,
        details: masked ? null : this.details
      }
    };
  }
}

// 一般的なエラーをAPIエラーに変換
function convertToAPIError(err) {
  // 既にAPIErrorの場合はそのまま返す
  if (err instanceof APIError) {
    return err;
  }

  let type = ErrorTypes.INTERNAL;
  let statusCode = 500;
  let message = err.message || 'An unexpected error occurred';

  // エラーオブジェクト自体に statusCode が付いていればそれを尊重する（axios, http-errors 等）。
  // これにより外部ライブラリのエラーがメッセージ文言の偶発的キーワードマッチで
  // 誤分類（例: "invalid cursor" → 400、"invoice timeout" → 400）されるのを防ぐ。
  if (typeof err.statusCode === 'number' && err.statusCode >= 400) {
    statusCode = err.statusCode;
    type = statusCode < 500 ? ErrorTypes.VALIDATION : ErrorTypes.INTERNAL;
    return new APIError(type, message, statusCode, { originalError: err.name, code: err.code });
  }

  // statusCode を持たない未知の Error はデフォルト 500/INTERNAL のまま返す。
  // アプリケーションコードが意図した 4xx エラーは必ず new APIError(...) で明示的に投げること。
  // 以下のキーワードマッチはレガシー互換のためのフォールバックにすぎず、
  // 正確性より「何もしないより多少まし」を優先するベストエフォートである点に注意。
  if (err.message) {
    const msg = err.message.toLowerCase();

    if (msg.includes('not found') || msg.includes('does not exist')) {
      type = ErrorTypes.NOT_FOUND;
      statusCode = 404;
    } else if (msg.includes('unauthorized') || msg.includes('authentication')) {
      type = ErrorTypes.UNAUTHORIZED;
      statusCode = 401;
    } else if (msg.includes('permission') || msg.includes('forbidden')) {
      type = ErrorTypes.FORBIDDEN;
      statusCode = 403;
    } else if (msg.includes('conflict') || msg.includes('duplicate')) {
      type = ErrorTypes.CONFLICT;
      statusCode = 409;
    }
    // 旧: msg.includes('validation') || msg.includes('invalid') → 400
    // 削除理由: 内部エラー（UV_EINVAL, "invalid cursor state"等）を誤って 400 へ格下げし
    // 本番アラートを抑圧していたため。アプリ側で明示的に APIError を投げること。
    // 旧: msg.includes('gpu'/'p2p'/'lightning'/'lnd'/'payment'/'invoice') → 500 or 400
    // 削除理由: 'invoice timeout' → 400 のように正常な 5xx を 400 に格下げしていた。
  }

  return new APIError(type, message, statusCode, {
    originalError: err.name,
    code: err.code
  });
}

// Express用のエラーハンドラミドルウェア
function errorMiddleware(err, req, res, next) {
  // APIエラーに変換
  const apiError = convertToAPIError(err);
  
  // エラーをログに記録
  if (apiError.statusCode >= 500) {
    logger.error(`${apiError.type}: ${apiError.message}`, {
      path: req.path,
      method: req.method,
      statusCode: apiError.statusCode,
      stack: apiError.stack
    });
  } else {
    logger.warn(`${apiError.type}: ${apiError.message}`, {
      path: req.path,
      method: req.method,
      statusCode: apiError.statusCode
    });
  }
  
  // クライアントにレスポンスを返す（本番では 5xx 詳細をマスク）
  const maskInternal = process.env.NODE_ENV === 'production';
  res.status(apiError.statusCode).json(apiError.toJSON(maskInternal));
}

// 非同期ルートハンドラのラッパー
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 特定のエラータイプを作成するヘルパー関数
function createError(type, message, statusCode, details = null) {
  return new APIError(type, message, statusCode, details);
}

// 404エラー用のミドルウェア
function notFoundMiddleware(req, res, next) {
  // req.originalUrl をそのまま埋めると XSS / パス情報漏洩になる。
  // メソッドはホワイトリスト一致のみ通し、パスは英数字・/ . - _ のみ残す。
  const SAFE_METHODS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
  const method = SAFE_METHODS.has(req.method) ? req.method : 'UNKNOWN';
  const safePath = (req.path || '').replace(/[^a-zA-Z0-9/.\-_]/g, '').slice(0, 100);
  const err = new APIError(
    ErrorTypes.NOT_FOUND,
    `Route not found: ${method} ${safePath}`,
    404
  );
  next(err);
}

module.exports = {
  APIError,
  ErrorTypes,
  convertToAPIError,
  errorMiddleware,
  asyncHandler,
  createError,
  notFoundMiddleware
};
