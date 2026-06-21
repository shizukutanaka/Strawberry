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

// winston のログレコード（info）を機密マスキングする共通フィルタ。
// 重要な2点を担保する:
//  1) metadata splat の対象化: logger.error('msg', { body: req.body }) のように
//     第2引数で渡されたメタデータは info.message ではなく info 直下のキーに展開される。
//     旧実装は info.message が object のときしか見ておらず、メタdata 内の password/
//     apiKey 等がファイルログに素通りしていた（fail-open）。ここで info 直下の
//     メタデータキーも再帰的にマスクする。
//  2) json() より前に適用する: format.combine は左→右に適用され、json() が時点の info を
//     直列化して出力シンボルに焼き込む。json() の *後* にサニタイズしても出力には反映され
//     ないため、必ず json() の前段に置く。
const _LOG_SENSITIVE_LOWER = [
  'password','secret','token','apikey','privatekey','email',
  'refreshtoken','accesstoken','jwt','macaroon','mnemonic','seed'
];
const _RESERVED_LOG_KEYS = new Set(['level', 'message', 'timestamp', 'service', 'label', 'ms']);
const _MASK_MAX_DEPTH = 6;

// 機密キーを in-place でマスクする巡回・深さ安全な再帰。
// 重要: メタデータには axios のエラー（error.request ⇄ error.response の循環参照）など
// 巨大・循環するオブジェクトが渡されうる。無制限再帰は "Maximum call stack size exceeded"
// を引き起こし、ログ呼び出し自体を例外化してリクエストを巻き添えにする。よって
//  - WeakSet で訪問済みオブジェクトを記録して循環を断ち、
//  - 深さ上限を設け、
//  - プレーンオブジェクト/配列のみを降下対象にする（Error/Buffer/Stream 等の exotic
//    オブジェクトは循環の温床なので降下しない）。
function _maskInPlace(obj, seen, depth) {
  if (obj === null || typeof obj !== 'object' || depth > _MASK_MAX_DEPTH) return;
  if (seen.has(obj)) return;
  seen.add(obj);
  const isArray = Array.isArray(obj);
  if (!isArray) {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return; // プレーンオブジェクトのみ降下
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (!isArray && _LOG_SENSITIVE_LOWER.includes(k.toLowerCase())) {
      obj[k] = '[MASKED]';
    } else if (v && typeof v === 'object') {
      _maskInPlace(v, seen, depth + 1);
    }
  }
}

function redactLogInfo(info) {
  const seen = new WeakSet();
  // object 形式の message を再帰サニタイズ（in-place）
  if (info.message && typeof info.message === 'object') {
    _maskInPlace(info.message, seen, 0);
  }
  // metadata splat（info 直下のキー）を in-place でマスク。
  // winston は level/message を Symbol キーでも保持するため、info を新オブジェクトに
  // 置き換えず必ず in-place で変更する（Symbol メタを失わないため）。
  for (const k of Object.keys(info)) {
    if (_RESERVED_LOG_KEYS.has(k)) continue;
    const v = info[k];
    if (_LOG_SENSITIVE_LOWER.includes(k.toLowerCase())) {
      info[k] = '[MASKED]';
    } else if (v && typeof v === 'object') {
      _maskInPlace(v, seen, 1);
    }
  }
  return info;
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
    // maxsize + maxFiles でローテーションし、ログ肥大化（ディスク枯渇）を防ぐ。
    // 以前は無制限で、combined.log/error.log が数GBまで膨張し
    // readFileSync が ERR_STRING_TOO_LONG で失敗する事態を招いていた。
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        // サニタイズは json() より前（出力直列化前）に適用する。
        winston.format((info) => redactLogInfo(info))(),
        winston.format.json()
      )
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format((info) => redactLogInfo(info))(),
        winston.format.json()
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
  // winston のメタデータは format filter が message を object のときしかサニタイズ
  // しないため、ここで先にサニタイズしてから渡す。旧実装は同じイベントを 2 回 info
  // し、2 回目は data を生で渡していたため将来 apiKey 等を含む caller が
  // combined.log にプレーンで漏らす fail-open になっていた。
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

module.exports = { logger, redactLogInfo };
