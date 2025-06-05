// src/utils/config.js - 設定管理モジュール
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { logger } = require('./logger');

// .envファイルをロード
dotenv.config();

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
    jwtSecret: process.env.JWT_SECRET || 'strawberry-dev-jwt-secret',
    jwtExpiresIn: '24h',
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
  
  // サーバー設定
  if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) config.server.host = process.env.HOST;
  if (process.env.API_PREFIX) config.server.apiPrefix = process.env.API_PREFIX;
  if (process.env.CORS_ORIGINS) config.server.corsOrigins = process.env.CORS_ORIGINS;
  
  // P2P設定
  if (process.env.P2P_PORT) config.p2p.port = parseInt(process.env.P2P_PORT, 10);
  if (process.env.P2P_BOOTSTRAP_NODES) {
    try {
      config.p2p.bootstrapNodes = JSON.parse(process.env.P2P_BOOTSTRAP_NODES);
    } catch (e) {
      logger.warn('Invalid P2P_BOOTSTRAP_NODES format, using defaults');
    }
  }
  
  // GPU設定
  if (process.env.GPU_MIN_MEMORY_GB) {
    config.gpu.minMemoryGB = parseInt(process.env.GPU_MIN_MEMORY_GB, 10);
  }
  if (process.env.GPU_SCAN_INTERVAL_MS) {
    config.gpu.scanIntervalMs = parseInt(process.env.GPU_SCAN_INTERVAL_MS, 10);
  }
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
  if (process.env.BCRYPT_ROUNDS) {
    config.security.bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS, 10);
  }
  
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

module.exports = { config };
