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
  
  // P2Pネットワーク設定
  p2p: {
    bootstrapNodes: [
      '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      '/dns4/bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
    ],
    port: 9090,
    announceInterval: 60000, // 1分
    peerDiscoveryInterval: 300000, // 5分
  },
  
  // GPU設定
  gpu: {
    minMemoryGB: 4,
    scanIntervalMs: 60000, // 1分
    virtualGpuEnabled: true,
    dockerSupport: true,
    kubernetesSupport: false,
    priceUpdateIntervalMs: 300000, // 5分
  },
  
  // Lightning Network設定
  lightning: {
    network: 'testnet', // mainnet, testnet, regtest
    lndHost: '127.0.0.1:10009',
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
    corsEnabled: true,
    helmetEnabled: true,
  },
  
  // ログ設定
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    consoleEnabled: true,
    fileEnabled: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
  }
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

  // P2P設定
  const p2pPort = safeInt('P2P_PORT', 1, 65535);
  if (p2pPort !== undefined) config.p2p.port = p2pPort;
  if (process.env.P2P_BOOTSTRAP_NODES) {
    try {
      config.p2p.bootstrapNodes = JSON.parse(process.env.P2P_BOOTSTRAP_NODES);
    } catch (e) {
      logger.warn('Invalid P2P_BOOTSTRAP_NODES format, using defaults');
    }
  }
  
  // GPU設定
  const minMemGB = safeInt('GPU_MIN_MEMORY_GB', 1, 10000);
  if (minMemGB !== undefined) config.gpu.minMemoryGB = minMemGB;
  const scanMs = safeInt('GPU_SCAN_INTERVAL_MS', 1000, 86400000);
  if (scanMs !== undefined) config.gpu.scanIntervalMs = scanMs;
  if (process.env.VIRTUAL_GPU_ENABLED) {
    config.gpu.virtualGpuEnabled = process.env.VIRTUAL_GPU_ENABLED === 'true';
  }
  if (process.env.DOCKER_SUPPORT) {
    config.gpu.dockerSupport = process.env.DOCKER_SUPPORT === 'true';
  }
  if (process.env.KUBERNETES_SUPPORT) {
    config.gpu.kubernetesSupport = process.env.KUBERNETES_SUPPORT === 'true';
  }
  
  // Lightning設定
  if (process.env.BITCOIN_NETWORK) config.lightning.network = process.env.BITCOIN_NETWORK;
  if (process.env.LND_HOST) config.lightning.lndHost = process.env.LND_HOST;
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
  
  // ログ設定
  if (process.env.LOG_LEVEL) config.logging.level = process.env.LOG_LEVEL;
  if (process.env.LOG_CONSOLE_ENABLED) {
    config.logging.consoleEnabled = process.env.LOG_CONSOLE_ENABLED === 'true';
  }
  if (process.env.LOG_FILE_ENABLED) {
    config.logging.fileEnabled = process.env.LOG_FILE_ENABLED === 'true';
  }
  
  return config;
}

// 設定ファイルから読み込み (オプション)
// 従来は { ...defaultConfig, ...fileConfig } の浅いマージで、例えば
// {"server": {"port": 4000}} だけのファイルが server の他既定値
// (host/apiPrefix/corsOrigins/rateLimitMax) を丸ごと失わせていた。
// ここではパース結果のみ返し、マージは getConfig 側の深いマージに委ねる。
function loadFromFile(configPath) {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (error) {
    logger.error(`Failed to load config from ${configPath}:`, error);
  }
  return null;
}

// プレーンオブジェクト判定（配列は上書き対象であってマージしない）
function _isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 深いマージ: ネストしたキー単位で override を base へ適用する。
// __proto__/constructor/prototype はスキップしてプロトタイプ汚染を防ぐ
// （config.json はローカルファイルだが、JSON.parse は __proto__ を own プロパティ
// として持ち得るため防御的に除外）。
function deepMergeConfig(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const v = override[key];
    out[key] = _isPlainObject(v) && _isPlainObject(base[key])
      ? deepMergeConfig(base[key], v)
      : v;
  }
  return out;
}

// 最終的な設定を取得
function getConfig() {
  // 環境変数から設定をロード
  const envConfig = loadFromEnv();
  
  // カスタム設定ファイルがあれば読み込み
  const customConfigPath = path.join(process.cwd(), 'config.json');
  const fileConfig = loadFromFile(customConfigPath);
  
  // 設定をマージ (ファイル設定 > 環境変数設定 > デフォルト設定)
  // 従来 `fileConfig || envConfig` はファイルが存在すると環境変数オーバーライド
  // （PORT 等）を丸ごと捨てていた。深いマージでキー単位の優先順位にする。
  return fileConfig ? deepMergeConfig(envConfig, fileConfig) : envConfig;
}

const config = getConfig();
logger.info('Configuration loaded');

module.exports = { config, requireSecret };
// テスト用に内部マージ関数を公開
module.exports._deepMergeConfig = deepMergeConfig;
