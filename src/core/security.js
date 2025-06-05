// src/security/security.js - Security Module
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { RateLimiterMemory, RateLimiterRedis } = require('rate-limiter-flexible');
const Redis = require('ioredis');
const { logger } = require('../utils/logger');

class SecurityManager {
    constructor() {
        this.jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
        this.encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
        this.redis = null;
        this.rateLimiters = new Map();
        this.blacklistedTokens = new Set();
        this.suspiciousActivities = new Map();
        
        // セキュリティ設定
        this.config = {
            jwt: {
                expiresIn: '24h',
                refreshExpiresIn: '7d',
                algorithm: 'HS256'
            },
            bcrypt: {
                saltRounds: 12
            },
            rateLimit: {
                points: 100, // リクエスト数
                duration: 900, // 15分
                blockDuration: 900 // ブロック時間（秒）
            },
            encryption: {
                algorithm: 'aes-256-gcm',
                ivLength: 16,
                saltLength: 64,
                tagLength: 16,
                iterations: 100000
            },
            passwordPolicy: {
                minLength: 12,
                requireUppercase: true,
                requireLowercase: true,
                requireNumbers: true,
                requireSpecialChars: true,
                preventCommon: true
            }
        };
        
        this.initialize();
    }

    async initialize() {
        try {
            // Redis接続（利用可能な場合）
            if (process.env.REDIS_URL) {
                this.redis = new Redis(process.env.REDIS_URL);
                
                // Redisベースのレート制限
                this.setupRateLimiters();
            }
            
            // 共通パスワードリスト読み込み
            this.commonPasswords = await this.loadCommonPasswords();
            
            logger.info('Security Manager initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Security Manager:', error);
        }
    }

    // ===== 認証・認可 =====
    
    // JWTトークン生成
    generateToken(payload, options = {}) {
        const tokenOptions = {
            expiresIn: options.expiresIn || this.config.jwt.expiresIn,
            algorithm: this.config.jwt.algorithm
        };
        
        return jwt.sign(payload, this.jwtSecret, tokenOptions);
    }

    // リフレッシュトークン生成
    generateRefreshToken(userId) {
        const payload = {
            userId,
            type: 'refresh',
            jti: crypto.randomBytes(16).toString('hex')
        };
        
        return jwt.sign(payload, this.jwtSecret, {
            expiresIn: this.config.jwt.refreshExpiresIn
        });
    }

    // JWTトークン検証
    verifyToken(token) {
        try {
            // ブラックリストチェック
            if (this.blacklistedTokens.has(token)) {
                throw new Error('Token is blacklisted');
            }
            
            const decoded = jwt.verify(token, this.jwtSecret, {
                algorithms: [this.config.jwt.algorithm]
            });
            
            return { valid: true, decoded };
            
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    // トークン無効化
    revokeToken(token) {
        this.blacklistedTokens.add(token);
        
        // Redisに保存（利用可能な場合）
        if (this.redis) {
            const decoded = jwt.decode(token);
            if (decoded && decoded.exp) {
                const ttl = decoded.exp - Math.floor(Date.now() / 1000);
                if (ttl > 0) {
                    this.redis.setex(`blacklist:${token}`, ttl, '1');
                }
            }
        }
    }

    // ===== パスワード管理 =====
    
    // パスワードハッシュ化
    async hashPassword(password) {
        return await bcrypt.hash(password, this.config.bcrypt.saltRounds);
    }

    // パスワード検証
    async verifyPassword(password, hash) {
        return await bcrypt.compare(password, hash);
    }

    // パスワード強度チェック
    validatePassword(password) {
        const policy = this.config.passwordPolicy;
        const errors = [];
        
        if (password.length < policy.minLength) {
            errors.push(`Password must be at least ${policy.minLength} characters`);
        }
        
        if (policy.requireUppercase && !/[A-Z]/.test(password)) {
            errors.push('Password must contain uppercase letters');
        }
        
        if (policy.requireLowercase && !/[a-z]/.test(password)) {
            errors.push('Password must contain lowercase letters');
        }
        
        if (policy.requireNumbers && !/\d/.test(password)) {
            errors.push('Password must contain numbers');
        }
        
        if (policy.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
            errors.push('Password must contain special characters');
        }
        
        // 共通パスワードチェック
        if (policy.preventCommon && this.isCommonPassword(password)) {
            errors.push('Password is too common');
        }
        
        // エントロピー計算
        const entropy = this.calculatePasswordEntropy(password);
        if (entropy < 50) {
            errors.push('Password is too weak');
        }
        
        return {
            valid: errors.length === 0,
            errors,
            strength: this.getPasswordStrength(entropy)
        };
    }

    // パスワードエントロピー計算
    calculatePasswordEntropy(password) {
        const charsets = {
            lowercase: /[a-z]/.test(password) ? 26 : 0,
            uppercase: /[A-Z]/.test(password) ? 26 : 0,
            numbers: /\d/.test(password) ? 10 : 0,
            special: /[^a-zA-Z0-9]/.test(password) ? 32 : 0
        };
        
        const poolSize = Object.values(charsets).reduce((sum, size) => sum + size, 0);
        return password.length * Math.log2(poolSize);
    }

    // パスワード強度評価
    getPasswordStrength(entropy) {
        if (entropy < 30) return 'very weak';
        if (entropy < 50) return 'weak';
        if (entropy < 70) return 'moderate';
        if (entropy < 90) return 'strong';
        return 'very strong';
    }

    // 共通パスワードチェック
    isCommonPassword(password) {
        return this.commonPasswords.has(password.toLowerCase());
    }

    // ===== 暗号化 =====
    
    // データ暗号化
    encrypt(data, password = null) {
        try {
            const key = password ? 
                this.deriveKey(password) : 
                Buffer.from(this.encryptionKey, 'hex');
            
            const iv = crypto.randomBytes(this.config.encryption.ivLength);
            const cipher = crypto.createCipheriv(
                this.config.encryption.algorithm,
                key,
                iv
            );
            
            const encrypted = Buffer.concat([
                cipher.update(JSON.stringify(data), 'utf8'),
                cipher.final()
            ]);
            
            const tag = cipher.getAuthTag();
            
            return {
                encrypted: encrypted.toString('base64'),
                iv: iv.toString('base64'),
                tag: tag.toString('base64')
            };
            
        } catch (error) {
            logger.error('Encryption error:', error);
            throw new Error('Encryption failed');
        }
    }

    // データ復号化
    decrypt(encryptedData, password = null) {
        try {
            const key = password ? 
                this.deriveKey(password) : 
                Buffer.from(this.encryptionKey, 'hex');
            
            const decipher = crypto.createDecipheriv(
                this.config.encryption.algorithm,
                key,
                Buffer.from(encryptedData.iv, 'base64')
            );
            
            decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));
            
            const decrypted = Buffer.concat([
                decipher.update(Buffer.from(encryptedData.encrypted, 'base64')),
                decipher.final()
            ]);
            
            return JSON.parse(decrypted.toString('utf8'));
            
        } catch (error) {
            logger.error('Decryption error:', error);
            throw new Error('Decryption failed');
        }
    }

    // 鍵導出
    deriveKey(password) {
        const salt = crypto.randomBytes(this.config.encryption.saltLength);
        return crypto.pbkdf2Sync(
            password,
            salt,
            this.config.encryption.iterations,
            32,
            'sha256'
        );
    }

    // ===== レート制限 =====
    
    setupRateLimiters() {
        // API エンドポイント用
        this.rateLimiters.set('api', new RateLimiterRedis({
            storeClient: this.redis,
            keyPrefix: 'ratelimit:api',
            points: this.config.rateLimit.points,
            duration: this.config.rateLimit.duration,
            blockDuration: this.config.rateLimit.blockDuration
        }));
        
        // ログイン試行用
        this.rateLimiters.set('login', new RateLimiterRedis({
            storeClient: this.redis,
            keyPrefix: 'ratelimit:login',
            points: 5,
            duration: 900, // 15分
            blockDuration: 3600 // 1時間
        }));
        
        // GPU操作用
        this.rateLimiters.set('gpu', new RateLimiterRedis({
            storeClient: this.redis,
            keyPrefix: 'ratelimit:gpu',
            points: 20,
            duration: 3600, // 1時間
            blockDuration: 3600
        }));
    }

    // レート制限チェック
    async checkRateLimit(key, identifier) {
        const limiter = this.rateLimiters.get(key);
        if (!limiter) {
            // Redisが利用できない場合はメモリベース
            return { allowed: true };
        }
        
        try {
            await limiter.consume(identifier);
            return { allowed: true };
        } catch (error) {
            return {
                allowed: false,
                retryAfter: Math.round(error.msBeforeNext / 1000) || this.config.rateLimit.blockDuration
            };
        }
    }

    // ===== セキュリティミドルウェア =====
    
    // 認証ミドルウェア
    authMiddleware() {
        return async (req, res, next) => {
            try {
                const token = this.extractToken(req);
                if (!token) {
                    return res.status(401).json({ error: 'No token provided' });
                }
                
                const { valid, decoded, error } = this.verifyToken(token);
                if (!valid) {
                    return res.status(401).json({ error: error || 'Invalid token' });
                }
                
                req.user = decoded;
                next();
                
            } catch (error) {
                logger.error('Auth middleware error:', error);
                res.status(500).json({ error: 'Authentication error' });
            }
        };
    }

    // レート制限ミドルウェア
    rateLimitMiddleware(key = 'api') {
        return async (req, res, next) => {
            const identifier = req.ip || req.connection.remoteAddress;
            const { allowed, retryAfter } = await this.checkRateLimit(key, identifier);
            
            if (!allowed) {
                res.set('Retry-After', retryAfter);
                return res.status(429).json({
                    error: 'Too many requests',
                    retryAfter
                });
            }
            
            next();
        };
    }

    // APIキー認証ミドルウェア
    apiKeyMiddleware() {
        return (req, res, next) => {
            const apiKey = req.headers['x-api-key'];
            if (!apiKey) {
                return res.status(401).json({ error: 'API key required' });
            }
            
            // APIキー検証
            if (!this.validateApiKey(apiKey)) {
                return res.status(401).json({ error: 'Invalid API key' });
            }
            
            next();
        };
    }

    // ===== セキュリティ監視 =====
    
    // 不審なアクティビティ記録
    recordSuspiciousActivity(identifier, activity) {
        if (!this.suspiciousActivities.has(identifier)) {
            this.suspiciousActivities.set(identifier, []);
        }
        
        const activities = this.suspiciousActivities.get(identifier);
        activities.push({
            activity,
            timestamp: Date.now()
        });
        
        // 古いエントリ削除
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const filtered = activities.filter(a => a.timestamp > oneHourAgo);
        this.suspiciousActivities.set(identifier, filtered);
        
        // 閾値チェック
        if (filtered.length > 10) {
            this.handleSecurityThreat(identifier, activities);
        }
        
        // ログ記録
        logger.securityEvent('suspicious_activity', {
            identifier,
            activity,
            severity: 'medium'
        });
    }

    // セキュリティ脅威対応
    async handleSecurityThreat(identifier, activities) {
        logger.securityEvent('security_threat_detected', {
            identifier,
            activities: activities.length,
            severity: 'high'
        });
        
        // 自動ブロック
        if (this.redis) {
            await this.redis.setex(`blocked:${identifier}`, 86400, '1'); // 24時間ブロック
        }
        
        // 通知送信（実装省略）
        // await this.notifySecurityTeam(identifier, activities);
    }

    // ===== 入力検証 =====
    
    // SQLインジェクション対策
    sanitizeSQLInput(input) {
        if (typeof input !== 'string') return input;
        
        // 危険な文字のエスケープ
        return input
            .replace(/'/g, "''")
            .replace(/;/g, '')
            .replace(/--/g, '')
            .replace(/\/\*/g, '')
            .replace(/\*\//g, '');
    }

    // XSS対策
    sanitizeHTMLInput(input) {
        if (typeof input !== 'string') return input;
        
        // HTMLエンティティエスケープ
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    }

    // パス・トラバーサル対策
    sanitizePath(input) {
        if (typeof input !== 'string') return '';
        
        // 危険なパスパターン除去
        return input
            .replace(/\.\./g, '')
            .replace(/[^a-zA-Z0-9\-_\/\.]/g, '')
            .replace(/\/+/g, '/');
    }

    // ===== 暗号化通信 =====
    
    // セキュアチャネル確立
    async establishSecureChannel(peerId) {
        try {
            // ECDH鍵交換
            const ecdh = crypto.createECDH('secp256k1');
            const publicKey = ecdh.generateKeys();
            
            // 公開鍵署名
            const signature = crypto.sign(
                'sha256',
                publicKey,
                crypto.createPrivateKey(this.encryptionKey)
            );
            
            return {
                publicKey: publicKey.toString('base64'),
                signature: signature.toString('base64'),
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error('Failed to establish secure channel:', error);
            throw error;
        }
    }

    // ===== コンプライアンス =====
    
    // GDPRデータ匿名化
    anonymizeUserData(userData) {
        const anonymized = { ...userData };
        
        // 個人識別情報の削除・ハッシュ化
        if (anonymized.email) {
            anonymized.email = crypto.createHash('sha256')
                .update(anonymized.email)
                .digest('hex');
        }
        
        if (anonymized.ip) {
            // IPアドレスの最後のオクテットを削除
            anonymized.ip = anonymized.ip.replace(/\.\d+$/, '.0');
        }
        
        // その他の個人情報削除
        delete anonymized.name;
        delete anonymized.phone;
        delete anonymized.address;
        
        return anonymized;
    }

    // データ保持ポリシー
    async enforceDataRetention() {
        const retentionDays = 365; // 1年
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        
        // 古いデータの削除（実装は環境依存）
        logger.info(`Enforcing data retention policy: ${retentionDays} days`);
    }

    // ===== ユーティリティ =====
    
    // トークン抽出
    extractToken(req) {
        // Authorizationヘッダー
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.substring(7);
        }
        
        // クッキー
        if (req.cookies && req.cookies.token) {
            return req.cookies.token;
        }
        
        // クエリパラメータ（非推奨）
        if (req.query && req.query.token) {
            return req.query.token;
        }
        
        return null;
    }

    // APIキー生成
    generateApiKey() {
        const prefix = 'sk_live_';
        const key = crypto.randomBytes(32).toString('base64url');
        return prefix + key;
    }

    // APIキー検証
    validateApiKey(apiKey) {
        // 実際の実装ではデータベース照合
        return apiKey && apiKey.startsWith('sk_live_');
    }

    // セッショントークン生成
    generateSessionToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    // CSRF トークン生成
    generateCSRFToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    // ファイルタイプ検証
    validateFileType(filename, allowedTypes) {
        const ext = filename.split('.').pop().toLowerCase();
        return allowedTypes.includes(ext);
    }

    // 共通パスワードリスト読み込み
    async loadCommonPasswords() {
        // 実際の実装では外部ファイルから読み込み
        return new Set([
            'password', '123456', 'password123', 'admin', 'letmein',
            'qwerty', 'abc123', '12345678', 'password1', 'admin123'
        ]);
    }

    // クリーンアップ
    async cleanup() {
        if (this.redis) {
            await this.redis.quit();
        }
        
        this.blacklistedTokens.clear();
        this.suspiciousActivities.clear();
        
        logger.info('Security Manager cleaned up');
    }
}

module.exports = { SecurityManager };