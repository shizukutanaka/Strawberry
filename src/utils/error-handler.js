// src/utils/error-handler.js - エラーハンドリングユーティリティ
const { logger } = require('./logger');

// エラータイプの定義
const ErrorTypes = {
  VALIDATION: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED_ERROR',
  FORBIDDEN: 'FORBIDDEN_ERROR',
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
  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        statusCode: this.statusCode,
        timestamp: this.timestamp,
        details: this.details
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
  
  // エラータイプを判定
  let type = ErrorTypes.INTERNAL;
  let statusCode = 500;
  let message = err.message || 'An unexpected error occurred';
  
  // エラーメッセージからタイプを推測
  if (err.message) {
    const msg = err.message.toLowerCase();
    
    if (msg.includes('not found') || msg.includes('does not exist')) {
      type = ErrorTypes.NOT_FOUND;
      statusCode = 404;
    } else if (msg.includes('validation') || msg.includes('invalid')) {
      type = ErrorTypes.VALIDATION;
      statusCode = 400;
    } else if (msg.includes('unauthorized') || msg.includes('authentication')) {
      type = ErrorTypes.UNAUTHORIZED;
      statusCode = 401;
    } else if (msg.includes('permission') || msg.includes('forbidden')) {
      type = ErrorTypes.FORBIDDEN;
      statusCode = 403;
    } else if (msg.includes('conflict') || msg.includes('duplicate')) {
      type = ErrorTypes.CONFLICT;
      statusCode = 409;
    } else if (msg.includes('gpu')) {
      type = ErrorTypes.GPU_ERROR;
      statusCode = 500;
    } else if (msg.includes('p2p') || msg.includes('peer')) {
      type = ErrorTypes.P2P_ERROR;
      statusCode = 500;
    } else if (msg.includes('lightning') || msg.includes('lnd')) {
      type = ErrorTypes.LIGHTNING_ERROR;
      statusCode = 500;
    } else if (msg.includes('payment') || msg.includes('invoice')) {
      type = ErrorTypes.PAYMENT_ERROR;
      statusCode = 400;
    }
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
  
  // クライアントにレスポンスを返す
  res.status(apiError.statusCode).json(apiError.toJSON());
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
  const err = new APIError(
    ErrorTypes.NOT_FOUND,
    `Route not found: ${req.method} ${req.originalUrl}`,
    404
  );
  next(err);
}

module.exports = {
  APIError,
  ErrorTypes,
  errorMiddleware,
  asyncHandler,
  createError,
  notFoundMiddleware
};
