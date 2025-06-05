// src/utils/logger.js - Logger Utility
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// ログディレクトリ作成
const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// カスタムフォーマット
const customFormat = winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    if (Object.keys(metadata).length > 0) {
        // エラーオブジェクトの処理
        if (metadata.error && metadata.error instanceof Error) {
            metadata.error = {
                message: metadata.error.message,
                stack: metadata.error.stack,
                ...metadata.error
            };
        }
        
        // メタデータを読みやすい形式で追加
        const metaStr = JSON.stringify(metadata, null, 2);
        if (metaStr !== '{}') {
            msg += `\n${metaStr}`;
        }
    }
    
    return msg;
});

// カラーテーマ設定
winston.addColors({
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'white'
});

// トランスポート設定
const transports = [];

// コンソール出力（開発環境）
if (process.env.NODE_ENV !== 'production') {
    transports.push(
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                customFormat
            )
        })
    );
}

// ファイル出力（全ログ）
transports.push(
    new DailyRotateFile({
        filename: path.join(logDir, 'strawberry-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            customFormat
        )
    })
);

// エラーログ専用ファイル
transports.push(
    new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '30d',
        level: 'error',
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            customFormat
        )
    })
);

// Logger インスタンス作成
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat()
    ),
    transports: transports,
    exitOnError: false
});

// HTTPリクエストロギング用ミドルウェア
logger.httpMiddleware = (req, res, next) => {
    const startTime = Date.now();
    
    // レスポンス終了時にログ記録
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const message = `${req.method} ${req.originalUrl}`;
        
        const logData = {
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.get('user-agent')
        };
        
        // ステータスコードに応じてログレベル変更
        if (res.statusCode >= 500) {
            logger.error(message, logData);
        } else if (res.statusCode >= 400) {
            logger.warn(message, logData);
        } else {
            logger.http(message, logData);
        }
    });
    
    next();
};

// GPUイベント専用ロガー
logger.gpuEvent = (event, data) => {
    const gpuLogPath = path.join(logDir, 'gpu-events.log');
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        event,
        data
    };
    
    // 非同期でファイルに追記
    fs.appendFile(
        gpuLogPath,
        JSON.stringify(logEntry) + '\n',
        (err) => {
            if (err) {
                logger.error('Failed to write GPU event log:', err);
            }
        }
    );
    
    // 通常のログにも記録
    logger.info(`GPU Event: ${event}`, data);
};

// 決済イベント専用ロガー
logger.paymentEvent = (event, data) => {
    const paymentLogPath = path.join(logDir, 'payment-events.log');
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        event,
        data: {
            ...data,
            // センシティブ情報のマスキング
            paymentRequest: data.paymentRequest ? `${data.paymentRequest.substring(0, 20)}...` : undefined,
            paymentPreimage: data.paymentPreimage ? `${data.paymentPreimage.substring(0, 10)}...` : undefined
        }
    };
    
    fs.appendFile(
        paymentLogPath,
        JSON.stringify(logEntry) + '\n',
        (err) => {
            if (err) {
                logger.error('Failed to write payment event log:', err);
            }
        }
    );
    
    logger.info(`Payment Event: ${event}`, logEntry.data);
};

// セキュリティイベント専用ロガー
logger.securityEvent = (event, data) => {
    const securityLogPath = path.join(logDir, 'security-events.log');
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        event,
        severity: data.severity || 'info',
        data
    };
    
    fs.appendFile(
        securityLogPath,
        JSON.stringify(logEntry) + '\n',
        (err) => {
            if (err) {
                logger.error('Failed to write security event log:', err);
            }
        }
    );
    
    // 重要度に応じてログレベル変更
    const level = data.severity === 'critical' ? 'error' : 
                  data.severity === 'high' ? 'warn' : 'info';
    
    logger[level](`Security Event: ${event}`, data);
};

// パフォーマンスメトリクスロガー
logger.performanceMetric = (metric, value, metadata = {}) => {
    const metricsLogPath = path.join(logDir, 'performance-metrics.log');
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        metric,
        value,
        ...metadata
    };
    
    fs.appendFile(
        metricsLogPath,
        JSON.stringify(logEntry) + '\n',
        (err) => {
            if (err) {
                logger.error('Failed to write performance metric:', err);
            }
        }
    );
    
    logger.debug(`Performance Metric: ${metric}`, { value, ...metadata });
};

// エラーレポート機能
logger.reportError = async (error, context = {}) => {
    const errorReport = {
        timestamp: new Date().toISOString(),
        error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
            code: error.code
        },
        context: {
            ...context,
            nodeVersion: process.version,
            platform: process.platform,
            memory: process.memoryUsage(),
            uptime: process.uptime()
        }
    };
    
    // エラーレポートファイルに保存
    const reportPath = path.join(logDir, 'error-reports', `error-${Date.now()}.json`);
    const reportDir = path.dirname(reportPath);
    
    try {
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        
        await fs.promises.writeFile(
            reportPath,
            JSON.stringify(errorReport, null, 2)
        );
        
        logger.error('Error reported:', errorReport);
        
        // 本番環境では外部エラー追跡サービスに送信
        if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
            // Sentry統合例
            // Sentry.captureException(error, { extra: context });
        }
        
    } catch (writeError) {
        logger.error('Failed to write error report:', writeError);
    }
};

// ログローテーション通知
transports.forEach(transport => {
    if (transport.on) {
        transport.on('rotate', (oldFilename, newFilename) => {
            logger.info('Log file rotated', { oldFilename, newFilename });
        });
        
        transport.on('error', (error) => {
            console.error('Logger transport error:', error);
        });
    }
});

// プロセス終了時のクリーンアップ
process.on('SIGINT', () => {
    logger.info('Application shutting down...');
    logger.end();
});

// 未処理の例外とPromiseリジェクションのキャッチ
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    logger.reportError(error, { type: 'uncaughtException' });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
    logger.reportError(new Error(reason), { 
        type: 'unhandledRejection',
        promise: promise.toString()
    });
});

// ログレベル動的変更
logger.setLevel = (level) => {
    logger.level = level;
    logger.info(`Log level changed to: ${level}`);
};

// ログ検索機能
logger.searchLogs = async (criteria) => {
    const { startDate, endDate, level, keyword } = criteria;
    const results = [];
    
    try {
        const files = await fs.promises.readdir(logDir);
        const logFiles = files.filter(f => f.endsWith('.log') && !f.includes('error'));
        
        for (const file of logFiles) {
            const content = await fs.promises.readFile(
                path.join(logDir, file),
                'utf8'
            );
            
            const lines = content.split('\n').filter(line => {
                if (!line) return false;
                
                try {
                    const log = JSON.parse(line);
                    const logDate = new Date(log.timestamp);
                    
                    if (startDate && logDate < startDate) return false;
                    if (endDate && logDate > endDate) return false;
                    if (level && log.level !== level) return false;
                    if (keyword && !JSON.stringify(log).includes(keyword)) return false;
                    
                    return true;
                } catch {
                    return false;
                }
            });
            
            results.push(...lines.map(line => JSON.parse(line)));
        }
        
        return results;
        
    } catch (error) {
        logger.error('Log search failed:', error);
        return [];
    }
};

// ログ統計
logger.getStats = async () => {
    try {
        const files = await fs.promises.readdir(logDir);
        const stats = {
            totalFiles: files.length,
            totalSize: 0,
            levelCounts: {
                error: 0,
                warn: 0,
                info: 0,
                debug: 0
            },
            oldestLog: null,
            newestLog: null
        };
        
        for (const file of files) {
            const filePath = path.join(logDir, file);
            const fileStat = await fs.promises.stat(filePath);
            stats.totalSize += fileStat.size;
            
            if (!stats.oldestLog || fileStat.birthtime < stats.oldestLog) {
                stats.oldestLog = fileStat.birthtime;
            }
            
            if (!stats.newestLog || fileStat.mtime > stats.newestLog) {
                stats.newestLog = fileStat.mtime;
            }
        }
        
        // サイズを人間が読める形式に変換
        stats.totalSizeFormatted = formatBytes(stats.totalSize);
        
        return stats;
        
    } catch (error) {
        logger.error('Failed to get log stats:', error);
        return null;
    }
};

// ヘルパー関数
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = { logger };