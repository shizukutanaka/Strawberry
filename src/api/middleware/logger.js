// src/api/middleware/logger.js - リクエストログミドルウェア
const morgan = require('morgan');
const { logger } = require('../../utils/logger');

// カスタムトークン定義
morgan.token('id', (req) => req.id);
morgan.token('user', (req) => (req.user ? req.user.id : 'anonymous'));
morgan.token('body', (req) => {
  // 機密情報をマスク
  const body = { ...req.body };
  
  // パスワードなどの機密情報をマスク
  if (body.password) body.password = '[REDACTED]';
  if (body.token) body.token = '[REDACTED]';
  if (body.paymentRequest) body.paymentRequest = '[REDACTED]';
  
  return JSON.stringify(body);
});

// リクエストIDを生成するミドルウェア。
// - 上流（プロキシ/ゲートウェイ）が付与した X-Request-Id があれば、安全な書式
//   （英数字・._- のみ、1〜128文字）の場合に限り再利用し、サービス間トレースを連結する。
//   不正・過長な値は採用しない（ログ injection / ヘッダ汚染を避ける）。
// - 無ければ UUID v4 を採番する。
// - 確定した ID を X-Request-Id レスポンスヘッダに反映し、クライアント/プロキシが
//   同一リクエストを相関できるようにする（障害時の問い合わせ ID になる）。
const { v4: uuidv4 } = require('uuid');
const { runWithContext, parseTraceId } = require('../../utils/request-context');
const _REQUEST_ID_SAFE = /^[A-Za-z0-9._-]{1,128}$/;
const requestId = (req, res, next) => {
  const inbound = req.headers['x-request-id'];
  req.id = (typeof inbound === 'string' && _REQUEST_ID_SAFE.test(inbound)) ? inbound : uuidv4();
  res.setHeader('X-Request-Id', req.id);
  // 上流が付与した W3C traceparent があれば trace-id を取り込み、サービス横断で
  // ログを相関できるようにする（不正・未指定なら undefined のまま）。
  const traceId = parseTraceId(req.headers['traceparent']) || undefined;
  if (traceId) req.traceId = traceId;
  // 以降のミドルウェア/ハンドラを requestId/traceId コンテキスト下で実行し、その中の
  // すべての logger.* が自動的に相関 ID を持つようにする（AsyncLocalStorage）。
  runWithContext({ requestId: req.id, traceId }, () => next());
};

// リクエストロガー
const requestLogger = morgan(
  ':id :remote-addr - :user ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" - :response-time ms',
  {
    stream: {
      write: (message) => {
        logger.info(message.trim());
      },
    },
  }
);

// 詳細なリクエストロガー（開発環境用）
const devRequestLogger = morgan(
  ':id :method :url :status :response-time ms - :body',
  {
    stream: {
      write: (message) => {
        logger.debug(message.trim());
      },
    },
  }
);

// レスポンスタイム測定ミドルウェア
const responseTime = (req, res, next) => {
  const start = Date.now();
  
  // レスポンス送信後に実行
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // 遅いレスポンスを警告
    if (duration > 1000) {
      logger.warn(`Slow response: ${req.method} ${req.originalUrl} - ${duration}ms`);
    }
    
    // メトリクス収集（将来的に拡張）
    // TODO: Prometheusなどのメトリクス収集システムと連携
  });
  
  next();
};

// エラーロガー
const errorLogger = (err, req, res, next) => {
  // エラーの詳細をログに記録
  logger.error(`${err.name || 'Error'}: ${err.message}`, {
    requestId: req.id,
    path: req.originalUrl,
    method: req.method,
    statusCode: err.statusCode || 500,
    stack: err.stack,
    user: req.user ? req.user.id : 'anonymous'
  });
  
  next(err);
};

module.exports = {
  requestId,
  requestLogger,
  devRequestLogger,
  responseTime,
  errorLogger
};
