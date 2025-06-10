// src/utils/logger.js - ロギングモジュール
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { sanitizeSensitiveFields } = require('./sanitize');

// ログディレクトリ
const logDir = path.join(__dirname, '../../logs');

// ログディレクトリが存在しない場合は作成
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// ロガー設定
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'strawberry-gpu' },
  transports: [
    // コンソール出力
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          info => `${info.timestamp} ${info.level}: ${typeof info.message === 'object' ? JSON.stringify(sanitizeSensitiveFields(info.message)) : info.message}`
        )
      )
    }),
    // ファイル出力
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
        winston.format((info) => {
          if (typeof info.message === 'object') {
            info.message = sanitizeSensitiveFields(info.message);
          }
          return info;
        })()
      )
    }),
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
        winston.format((info) => {
          if (typeof info.message === 'object') {
            info.message = sanitizeSensitiveFields(info.message);
          }
          return info;
        })()
      )
    })
  ]
});

// バイトサイズのフォーマット
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// GPUイベント専用ロガー
logger.gpuEvent = (event, data) => {
  const gpuLogPath = path.join(logDir, 'gpu-events.log');
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    data: sanitizeSensitiveFields(data),
  };
  fs.appendFileSync(gpuLogPath, JSON.stringify(logEntry) + '\n');
  logger.info(`GPU Event: ${event}`, sanitizeSensitiveFields(data));
  // 通常のログにも記録
  logger.info(`GPU Event: ${event}`, data);
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

module.exports = { logger };
