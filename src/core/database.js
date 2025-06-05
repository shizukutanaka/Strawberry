// src/database/database.js - Database Module
const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger } = require('../utils/logger');

class Database {
    constructor() {
        this.pg = null;
        this.redis = null;
        this.connected = false;
        
        this.config = {
            postgres: {
                connectionString: process.env.DATABASE_URL || 'postgresql://strawberry:password@localhost:5432/strawberry',
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 2000,
            },
            redis: {
                url: process.env.REDIS_URL || 'redis://localhost:6379',
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                lazyConnect: false
            }
        };
    }

    async connect() {
        try {
            logger.info('Connecting to databases...');
            
            // PostgreSQL接続
            this.pg = new Pool(this.config.postgres);
            
            // 接続テスト
            const pgClient = await this.pg.connect();
            await pgClient.query('SELECT NOW()');
            pgClient.release();
            
            logger.info('✅ PostgreSQL connected');
            
            // Redis接続
            this.redis = new Redis(this.config.redis.url, this.config.redis);
            
            await this.redis.ping();
            
            logger.info('✅ Redis connected');
            
            // テーブル作成
            await this.createTables();
            
            // インデックス作成
            await this.createIndexes();
            
            this.connected = true;
            
        } catch (error) {
            logger.error('Database connection failed:', error);
            throw error;
        }
    }

    async createTables() {
        const queries = [
            // ユーザーテーブル
            `CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                email VARCHAR(255) UNIQUE NOT NULL,
                username VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                lightning_node_pubkey VARCHAR(66),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(50) DEFAULT 'active',
                settings JSONB DEFAULT '{}'::jsonb,
                kyc_status VARCHAR(50) DEFAULT 'pending',
                kyc_data JSONB DEFAULT '{}'::jsonb
            )`,
            
            // GPUテーブル
            `CREATE TABLE IF NOT EXISTS gpus (
                id VARCHAR(100) PRIMARY KEY,
                user_id UUID REFERENCES users(id),
                name VARCHAR(255) NOT NULL,
                model JSONB NOT NULL,
                vram INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'offline',
                capabilities JSONB DEFAULT '{}'::jsonb,
                performance JSONB DEFAULT '{}'::jsonb,
                location VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // 貸出記録テーブル
            `CREATE TABLE IF NOT EXISTS lending_records (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                gpu_id VARCHAR(100) REFERENCES gpus(id),
                user_id UUID REFERENCES users(id),
                config JSONB NOT NULL,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'active',
                total_earnings DECIMAL(20, 8) DEFAULT 0,
                total_rentals INTEGER DEFAULT 0,
                total_duration DECIMAL(10, 2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // レンタル記録テーブル
            `CREATE TABLE IF NOT EXISTS rental_records (
                id VARCHAR(100) PRIMARY KEY,
                renter_user_id UUID REFERENCES users(id),
                provider_user_id UUID REFERENCES users(id),
                gpu_id VARCHAR(100) REFERENCES gpus(id),
                lending_record_id UUID REFERENCES lending_records(id),
                duration DECIMAL(10, 2) NOT NULL,
                hourly_rate DECIMAL(10, 4) NOT NULL,
                total_cost DECIMAL(20, 8) NOT NULL,
                platform_fee DECIMAL(20, 8) NOT NULL,
                provider_payment DECIMAL(20, 8) NOT NULL,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP NOT NULL,
                actual_end_time TIMESTAMP,
                status VARCHAR(50) DEFAULT 'pending',
                payment_hash VARCHAR(64),
                payment_preimage VARCHAR(64),
                invoice_data JSONB,
                access_credentials JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // 支払い記録テーブル
            `CREATE TABLE IF NOT EXISTS payments (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id),
                rental_id VARCHAR(100) REFERENCES rental_records(id),
                type VARCHAR(50) NOT NULL, -- 'rental', 'refund', 'withdrawal'
                amount DECIMAL(20, 8) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                amount_sats BIGINT,
                payment_hash VARCHAR(64) UNIQUE,
                payment_preimage VARCHAR(64),
                payment_request TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                metadata JSONB DEFAULT '{}'::jsonb
            )`,
            
            // GPUメトリクステーブル
            `CREATE TABLE IF NOT EXISTS gpu_metrics (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                gpu_id VARCHAR(100) REFERENCES gpus(id),
                timestamp TIMESTAMP NOT NULL,
                temperature DECIMAL(5, 2),
                utilization DECIMAL(5, 2),
                memory_utilization DECIMAL(5, 2),
                power_draw DECIMAL(6, 2),
                fan_speed DECIMAL(5, 2),
                clock_speed INTEGER,
                memory_clock_speed INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // セッションテーブル
            `CREATE TABLE IF NOT EXISTS sessions (
                id VARCHAR(100) PRIMARY KEY,
                user_id UUID REFERENCES users(id),
                rental_id VARCHAR(100) REFERENCES rental_records(id),
                vgpu_id VARCHAR(100),
                access_token VARCHAR(255) NOT NULL,
                refresh_token VARCHAR(255),
                expires_at TIMESTAMP NOT NULL,
                ip_address INET,
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // 監査ログテーブル
            `CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id),
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id VARCHAR(100),
                ip_address INET,
                user_agent TEXT,
                request_data JSONB,
                response_data JSONB,
                status VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            
            // 通知テーブル
            `CREATE TABLE IF NOT EXISTS notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID REFERENCES users(id),
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                data JSONB DEFAULT '{}'::jsonb,
                read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                read_at TIMESTAMP
            )`,
            
            // 価格履歴テーブル
            `CREATE TABLE IF NOT EXISTS price_history (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                gpu_model VARCHAR(255) NOT NULL,
                region VARCHAR(100),
                hourly_rate DECIMAL(10, 4) NOT NULL,
                demand_score DECIMAL(5, 2),
                supply_count INTEGER,
                timestamp TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`
        ];
        
        for (const query of queries) {
            try {
                await this.pg.query(query);
            } catch (error) {
                logger.error('Failed to create table:', error);
                throw error;
            }
        }
        
        logger.info('✅ Database tables created');
    }

    async createIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_gpus_user_id ON gpus(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_gpus_status ON gpus(status)',
            'CREATE INDEX IF NOT EXISTS idx_lending_records_gpu_id ON lending_records(gpu_id)',
            'CREATE INDEX IF NOT EXISTS idx_lending_records_status ON lending_records(status)',
            'CREATE INDEX IF NOT EXISTS idx_rental_records_renter_user_id ON rental_records(renter_user_id)',
            'CREATE INDEX IF NOT EXISTS idx_rental_records_provider_user_id ON rental_records(provider_user_id)',
            'CREATE INDEX IF NOT EXISTS idx_rental_records_gpu_id ON rental_records(gpu_id)',
            'CREATE INDEX IF NOT EXISTS idx_rental_records_status ON rental_records(status)',
            'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_payments_rental_id ON payments(rental_id)',
            'CREATE INDEX IF NOT EXISTS idx_payments_payment_hash ON payments(payment_hash)',
            'CREATE INDEX IF NOT EXISTS idx_gpu_metrics_gpu_id_timestamp ON gpu_metrics(gpu_id, timestamp DESC)',
            'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_user_id_read ON notifications(user_id, read)',
            'CREATE INDEX IF NOT EXISTS idx_price_history_gpu_model_timestamp ON price_history(gpu_model, timestamp DESC)'
        ];
        
        for (const index of indexes) {
            try {
                await this.pg.query(index);
            } catch (error) {
                logger.error('Failed to create index:', error);
            }
        }
        
        logger.info('✅ Database indexes created');
    }

    // GPU管理
    async saveGPU(gpu) {
        const query = `
            INSERT INTO gpus (id, user_id, name, model, vram, status, capabilities, performance, location)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                model = EXCLUDED.model,
                vram = EXCLUDED.vram,
                status = EXCLUDED.status,
                capabilities = EXCLUDED.capabilities,
                performance = EXCLUDED.performance,
                location = EXCLUDED.location,
                updated_at = CURRENT_TIMESTAMP,
                last_seen = CURRENT_TIMESTAMP
            RETURNING *
        `;
        
        const values = [
            gpu.id,
            gpu.userId,
            gpu.name,
            JSON.stringify(gpu.model),
            gpu.vram,
            gpu.status,
            JSON.stringify(gpu.capabilities),
            JSON.stringify(gpu.performance),
            gpu.location
        ];
        
        const result = await this.pg.query(query, values);
        return result.rows[0];
    }

    async getGPU(gpuId) {
        const query = 'SELECT * FROM gpus WHERE id = $1';
        const result = await this.pg.query(query, [gpuId]);
        return result.rows[0];
    }

    async getUserGPUs(userId) {
        const query = 'SELECT * FROM gpus WHERE user_id = $1 ORDER BY created_at DESC';
        const result = await this.pg.query(query, [userId]);
        return result.rows;
    }

    // 貸出記録管理
    async saveLendingRecord(record) {
        const query = `
            INSERT INTO lending_records (gpu_id, user_id, config, start_time, status)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
        
        const values = [
            record.gpuId,
            record.userId,
            JSON.stringify(record.config),
            record.startTime,
            'active'
        ];
        
        const result = await this.pg.query(query, values);
        
        // キャッシュ更新
        await this.redis.set(
            `lending:${record.gpuId}`,
            JSON.stringify(result.rows[0]),
            'EX',
            3600
        );
        
        return result.rows[0];
    }

    async updateLendingRecord(record) {
        const query = `
            UPDATE lending_records 
            SET end_time = $2, 
                status = $3, 
                total_earnings = $4, 
                total_duration = $5,
                total_rentals = $6
            WHERE gpu_id = $1 AND status = 'active'
            RETURNING *
        `;
        
        const values = [
            record.gpuId,
            record.endTime,
            'completed',
            record.totalEarnings,
            record.totalDuration,
            record.totalRentals || 0
        ];
        
        const result = await this.pg.query(query, values);
        
        // キャッシュ削除
        await this.redis.del(`lending:${record.gpuId}`);
        
        return result.rows[0];
    }

    // レンタル記録管理
    async saveRentalRecord(rental) {
        const query = `
            INSERT INTO rental_records (
                id, renter_user_id, provider_user_id, gpu_id, lending_record_id,
                duration, hourly_rate, total_cost, platform_fee, provider_payment,
                start_time, end_time, status, payment_hash, invoice_data, access_credentials
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING *
        `;
        
        const values = [
            rental.id,
            rental.renterUserId,
            rental.providerUserId,
            rental.gpuId,
            rental.lendingRecordId,
            rental.duration,
            rental.hourlyRate,
            rental.totalCost,
            rental.platformFee,
            rental.providerPayment,
            rental.startTime,
            rental.endTime,
            rental.status,
            rental.paymentHash,
            JSON.stringify(rental.invoice),
            JSON.stringify(rental.accessCredentials)
        ];
        
        const result = await this.pg.query(query, values);
        
        // キャッシュ設定
        await this.redis.set(
            `rental:${rental.id}`,
            JSON.stringify(result.rows[0]),
            'EX',
            rental.duration * 3600
        );
        
        return result.rows[0];
    }

    async updateRentalRecord(rental) {
        const query = `
            UPDATE rental_records 
            SET status = $2,
                actual_end_time = $3,
                payment_preimage = $4,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;
        
        const values = [
            rental.id,
            rental.status,
            rental.actualEndTime,
            rental.paymentPreimage
        ];
        
        const result = await this.pg.query(query, values);
        
        // キャッシュ更新
        await this.redis.set(
            `rental:${rental.id}`,
            JSON.stringify(result.rows[0]),
            'EX',
            3600
        );
        
        return result.rows[0];
    }

    async getRentalRecord(rentalId) {
        // キャッシュチェック
        const cached = await this.redis.get(`rental:${rentalId}`);
        if (cached) {
            return JSON.parse(cached);
        }
        
        const query = 'SELECT * FROM rental_records WHERE id = $1';
        const result = await this.pg.query(query, [rentalId]);
        
        if (result.rows[0]) {
            // キャッシュ設定
            await this.redis.set(
                `rental:${rentalId}`,
                JSON.stringify(result.rows[0]),
                'EX',
                3600
            );
        }
        
        return result.rows[0];
    }

    // 支払い記録管理
    async savePayment(payment) {
        const query = `
            INSERT INTO payments (
                user_id, rental_id, type, amount, currency, amount_sats,
                payment_hash, payment_request, status, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `;
        
        const values = [
            payment.userId,
            payment.rentalId,
            payment.type,
            payment.amount,
            payment.currency || 'USD',
            payment.amountSats,
            payment.paymentHash,
            payment.paymentRequest,
            payment.status,
            JSON.stringify(payment.metadata || {})
        ];
        
        const result = await this.pg.query(query, values);
        return result.rows[0];
    }

    async updatePayment(paymentHash, updates) {
        const query = `
            UPDATE payments 
            SET status = $2,
                payment_preimage = $3,
                completed_at = $4
            WHERE payment_hash = $1
            RETURNING *
        `;
        
        const values = [
            paymentHash,
            updates.status,
            updates.paymentPreimage,
            updates.completedAt
        ];
        
        const result = await this.pg.query(query, values);
        return result.rows[0];
    }

    // GPUメトリクス管理
    async saveGPUMetrics(metrics) {
        const query = `
            INSERT INTO gpu_metrics (
                gpu_id, timestamp, temperature, utilization, memory_utilization,
                power_draw, fan_speed, clock_speed, memory_clock_speed
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;
        
        const values = [
            metrics.gpuId,
            metrics.timestamp || new Date(),
            metrics.temperature,
            metrics.utilization,
            metrics.memoryUtilization,
            metrics.powerDraw,
            metrics.fanSpeed,
            metrics.clockSpeed,
            metrics.memoryClockSpeed
        ];
        
        await this.pg.query(query, values);
        
        // 時系列データをRedisに保存（1時間保持）
        const key = `metrics:${metrics.gpuId}:${Math.floor(Date.now() / 1000)}`;
        await this.redis.set(key, JSON.stringify(metrics), 'EX', 3600);
    }

    async getGPUMetrics(gpuId, startTime, endTime) {
        const query = `
            SELECT * FROM gpu_metrics 
            WHERE gpu_id = $1 
                AND timestamp >= $2 
                AND timestamp <= $3
            ORDER BY timestamp DESC
            LIMIT 1000
        `;
        
        const values = [gpuId, startTime, endTime];
        const result = await this.pg.query(query, values);
        return result.rows;
    }

    // セッション管理
    async createSession(session) {
        const query = `
            INSERT INTO sessions (
                id, user_id, rental_id, vgpu_id, access_token, 
                refresh_token, expires_at, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
        `;
        
        const values = [
            session.id,
            session.userId,
            session.rentalId,
            session.vgpuId,
            session.accessToken,
            session.refreshToken,
            session.expiresAt,
            session.ipAddress,
            session.userAgent
        ];
        
        const result = await this.pg.query(query, values);
        
        // Redisにセッション保存
        await this.redis.set(
            `session:${session.accessToken}`,
            JSON.stringify(result.rows[0]),
            'EX',
            Math.floor((session.expiresAt - Date.now()) / 1000)
        );
        
        return result.rows[0];
    }

    async getSession(accessToken) {
        // Redisチェック
        const cached = await this.redis.get(`session:${accessToken}`);
        if (cached) {
            return JSON.parse(cached);
        }
        
        const query = `
            SELECT * FROM sessions 
            WHERE access_token = $1 AND expires_at > CURRENT_TIMESTAMP
        `;
        const result = await this.pg.query(query, [accessToken]);
        
        if (result.rows[0]) {
            // Redisに再設定
            const session = result.rows[0];
            const ttl = Math.floor((new Date(session.expires_at) - Date.now()) / 1000);
            await this.redis.set(
                `session:${accessToken}`,
                JSON.stringify(session),
                'EX',
                ttl
            );
        }
        
        return result.rows[0];
    }

    async updateSessionActivity(sessionId) {
        const query = `
            UPDATE sessions 
            SET last_activity = CURRENT_TIMESTAMP 
            WHERE id = $1
        `;
        await this.pg.query(query, [sessionId]);
    }

    async deleteSession(accessToken) {
        await this.redis.del(`session:${accessToken}`);
        
        const query = 'DELETE FROM sessions WHERE access_token = $1';
        await this.pg.query(query, [accessToken]);
    }

    // 監査ログ
    async saveAuditLog(log) {
        const query = `
            INSERT INTO audit_logs (
                user_id, action, resource_type, resource_id,
                ip_address, user_agent, request_data, response_data, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;
        
        const values = [
            log.userId,
            log.action,
            log.resourceType,
            log.resourceId,
            log.ipAddress,
            log.userAgent,
            JSON.stringify(log.requestData || {}),
            JSON.stringify(log.responseData || {}),
            log.status
        ];
        
        await this.pg.query(query, values);
    }

    // 履歴取得
    async getRentalHistory(limit = 50, offset = 0) {
        const query = `
            SELECT r.*, g.name as gpu_name, u1.username as renter_username, u2.username as provider_username
            FROM rental_records r
            LEFT JOIN gpus g ON r.gpu_id = g.id
            LEFT JOIN users u1 ON r.renter_user_id = u1.id
            LEFT JOIN users u2 ON r.provider_user_id = u2.id
            ORDER BY r.created_at DESC
            LIMIT $1 OFFSET $2
        `;
        
        const result = await this.pg.query(query, [limit, offset]);
        return result.rows;
    }

    async getLendingHistory(limit = 50, offset = 0) {
        const query = `
            SELECT l.*, g.name as gpu_name, u.username
            FROM lending_records l
            LEFT JOIN gpus g ON l.gpu_id = g.id
            LEFT JOIN users u ON l.user_id = u.id
            ORDER BY l.created_at DESC
            LIMIT $1 OFFSET $2
        `;
        
        const result = await this.pg.query(query, [limit, offset]);
        return result.rows;
    }

    // 統計情報
    async getSystemStats() {
        const stats = {};
        
        // アクティブGPU数
        const activeGPUs = await this.pg.query(
            "SELECT COUNT(*) FROM gpus WHERE status IN ('available', 'lending')"
        );
        stats.activeGPUs = parseInt(activeGPUs.rows[0].count);
        
        // アクティブレンタル数
        const activeRentals = await this.pg.query(
            "SELECT COUNT(*) FROM rental_records WHERE status = 'active'"
        );
        stats.activeRentals = parseInt(activeRentals.rows[0].count);
        
        // 本日の収益
        const todayEarnings = await this.pg.query(`
            SELECT SUM(platform_fee) as total
            FROM rental_records
            WHERE status = 'completed'
                AND DATE(created_at) = CURRENT_DATE
        `);
        stats.todayEarnings = parseFloat(todayEarnings.rows[0].total || 0);
        
        // 総取引量
        const totalVolume = await this.pg.query(`
            SELECT SUM(total_cost) as total
            FROM rental_records
            WHERE status = 'completed'
        `);
        stats.totalVolume = parseFloat(totalVolume.rows[0].total || 0);
        
        return stats;
    }

    // 価格履歴
    async savePriceHistory(priceData) {
        const query = `
            INSERT INTO price_history (
                gpu_model, region, hourly_rate, demand_score, supply_count, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        const values = [
            priceData.gpuModel,
            priceData.region,
            priceData.hourlyRate,
            priceData.demandScore,
            priceData.supplyCount,
            priceData.timestamp || new Date()
        ];
        
        await this.pg.query(query, values);
    }

    async getPriceHistory(gpuModel, region, days = 7) {
        const query = `
            SELECT * FROM price_history
            WHERE gpu_model = $1
                AND ($2::varchar IS NULL OR region = $2)
                AND timestamp >= CURRENT_TIMESTAMP - INTERVAL '$3 days'
            ORDER BY timestamp DESC
        `;
        
        const result = await this.pg.query(query, [gpuModel, region, days]);
        return result.rows;
    }

    // トランザクション
    async executeTransaction(callback) {
        const client = await this.pg.connect();
        
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    // クリーンアップ
    async cleanupOldData() {
        // 古いメトリクスデータ削除（30日以上）
        await this.pg.query(`
            DELETE FROM gpu_metrics 
            WHERE timestamp < CURRENT_TIMESTAMP - INTERVAL '30 days'
        `);
        
        // 古い監査ログ削除（90日以上）
        await this.pg.query(`
            DELETE FROM audit_logs 
            WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
        `);
        
        // 期限切れセッション削除
        await this.pg.query(`
            DELETE FROM sessions 
            WHERE expires_at < CURRENT_TIMESTAMP
        `);
        
        logger.info('Database cleanup completed');
    }

    async disconnect() {
        try {
            if (this.pg) {
                await this.pg.end();
                logger.info('PostgreSQL disconnected');
            }
            
            if (this.redis) {
                await this.redis.quit();
                logger.info('Redis disconnected');
            }
            
            this.connected = false;
            
        } catch (error) {
            logger.error('Error disconnecting from databases:', error);
            throw error;
        }
    }
}

module.exports = { Database };