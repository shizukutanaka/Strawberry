// src/utils/config.js - 設定管理モジュール
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { logger } = require('./logger');

// .envファイルをロード
dotenv.config();

/**
 * 必須シークレットを取得する。
 * - 本番(NODE_ENV=production): env未設定 or 短すぎる場合は起動を失敗させる(fail-fast)。
 * - 開発/テスト: ランダムな一時シークレットを生成し、警告を出す。
 *   (プロセス再起動ごとに変わるため、安定運用には .env への設定が必要)
 * ハードコードされたフォールバック値を排除し、秘密鍵の漏洩を防ぐ。
 */
function requireSecret(name, { minLength = 16 } = {}) {
  const val = process.env[name];
  if (val && val.length >= minLength) return val;
  if (process.env.NODE_ENV === 'production') {
    const msg = `FATAL: required secret "${name}" is not set (or shorter than ${minLength} chars) in production`;
    logger.error(msg);
    throw new Error(msg);
  }
  const generated = crypto.randomBytes(32).toString('hex');
  logger.warn(`[security] "${name}" is not set; using an ephemeral dev secret. Set "${name}" in .env for stable sessions/tokens.`);
  return generated;
}

// デフォルト設定
const defaultConfig = {
  // サーバー設定
  server: {
    port: 3000,
    host: 'localhost',
    apiPrefix: '/api/v1',
    corsOrigins: '*',
    rateLimitMax: 100,
    rateLimitWindowMs: 15 * 60 * 1000, // 15分
  },

  
  // GPU設定
  gpu: {
    minMemoryGB: 4,
  },
  
  // Lightning Network設定
  lightning: {
    certPath: '',
    macaroonPath: '',
    invoiceExpirySeconds: 3600, // 1時間
    minPaymentSatoshis: 10,
    maxPaymentSatoshis: 1000000,
  },
  
  // セキュリティ設定
  security: {
    // RFC 7518 §3.2: HMAC-SHA256 requires a key of at least 256 bits (32 bytes).
    // 16-char default was insufficient; enforce 32-char minimum.
    jwtSecret: requireSecret('JWT_SECRET', { minLength: 32 }),
    // アクセストークンは短命にする。漏洩した場合の悪用期間を最大 1 時間に限定する。
    // 長時間セッション（GPU レンタル）はリフレッシュトークンローテーションで維持する。
    // 本番環境では JWT_EXPIRES_IN=15m など環境変数でさらに短縮することを推奨。
    jwtExpiresIn: '1h',
    // リフレッシュトークンの有効期限（短命アクセストークン + 長命リフレッシュの構成）
    jwtRefreshExpiresIn: '7d',
    bcryptRounds: 10,
    rateLimitEnabled: true,
  },
  
};

// 環境変数から設定をロード
function loadFromEnv() {
  const config = JSON.parse(JSON.stringify(defaultConfig)); // ディープコピー
  
  // 整数環境変数の安全パース（NaN を無視してデフォルトを維持）
  function safeInt(name, min, max) {
    const raw = process.env[name];
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      logger.warn(`Invalid ${name}="${raw}", expected integer ${min}–${max}; using default`);
      return undefined;
    }
    return n;
  }

  // サーバー設定
  const port = safeInt('PORT', 1, 65535);
  if (port !== undefined) config.server.port = port;
  if (process.env.HOST) config.server.host = process.env.HOST;
  if (process.env.API_PREFIX) config.server.apiPrefix = process.env.API_PREFIX;
  if (process.env.CORS_ORIGINS) config.server.corsOrigins = process.env.CORS_ORIGINS;

  // GPU設定
  const minMemGB = safeInt('GPU_MIN_MEMORY_GB', 1, 10000);
  if (minMemGB !== undefined) config.gpu.minMemoryGB = minMemGB;
  // Lightning設定
  if (process.env.LND_CERT_PATH) config.lightning.certPath = process.env.LND_CERT_PATH;
  if (process.env.LND_MACAROON_PATH) config.lightning.macaroonPath = process.env.LND_MACAROON_PATH;
  
  // セキュリティ設定
  if (process.env.JWT_SECRET) config.security.jwtSecret = process.env.JWT_SECRET;
  if (process.env.JWT_EXPIRES_IN) config.security.jwtExpiresIn = process.env.JWT_EXPIRES_IN;
  if (process.env.JWT_REFRESH_EXPIRES_IN) config.security.jwtRefreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN;
  // Minimum 10 rounds enforced: below 10 makes brute-force trivially fast
  // (cost doubles per round; rounds=1 is ~0.1ms vs rounds=10's ~100ms per hash).
  const bcryptRounds = safeInt('BCRYPT_ROUNDS', 10, 31);
  if (bcryptRounds !== undefined) config.security.bcryptRounds = bcryptRounds;

  
  return config;
}

// 設定ファイルから読み込み (オプション)
function loadFromFile(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaultConfig, ...fileConfig };
    }
  } catch (error) {
    logger.error(`Failed to load config from ${configPath}:`, error);
  }
  return null;
}

// 最終的な設定を取得
function getConfig() {
  // 環境変数から設定をロード
  const envConfig = loadFromEnv();
  
  // カスタム設定ファイルがあれば読み込み
  const customConfigPath = path.join(process.cwd(), 'config.json');
  const fileConfig = loadFromFile(customConfigPath);
  
  // 設定をマージ (ファイル設定 > 環境変数設定 > デフォルト設定)
  return fileConfig || envConfig;
}

const config = getConfig();
logger.info('Configuration loaded');

module.exports = { config, requireSecret };
