// src/core/strawberry-core-v2.js - Strawberry GPU Marketplace Core System（独自価格システム版）
const EventEmitter = require('events');
const { GPUDetector } = require('./gpu-detector');
const { P2PNetwork } = require('./p2p-network');
const { LightningService } = require('./lightning-service');
const { VirtualGPUManager } = require('./virtual-gpu-manager');
const { Database } = require('../database/database');
const { logger } = require('../utils/logger');
const { MetricsCollector } = require('../monitoring/metrics');
const { MarketPricingEngine } = require('./market-pricing-engine');
const { DynamicPricingEngine } = require('./dynamic-pricing-engine-v2');

class StrawberryCore extends EventEmitter {
    constructor() {
        super();
        this.gpuDetector = new GPUDetector();
        this.p2pNetwork = new P2PNetwork();
        this.lightning = new LightningService();
        this.vgpuManager = new VirtualGPUManager();
        this.db = new Database();
        this.metrics = new MetricsCollector();
        
        // 独自価格システム
        this.marketPricing = new MarketPricingEngine();
        this.dynamicPricing = new DynamicPricingEngine(this.db, this.marketPricing);
        
        this.localGPUs = new Map();
        this.activeRentals = new Map();
        this.activeLending = new Map();
        this.peerGPUs = new Map();
        
        this.initialized = false;
        this.platformFeeRate = 0.015; // 1.5%
        this.profitAddress = 'bc1qushc2p28sllf74xsk348xukfcuhmljcs2g2w7n';
    }

    async initialize() {
        try {
            logger.info('🍓 Initializing Strawberry Core...');
            
            // データベース接続
            await this.db.connect();
            
            // 価格エンジン初期化
            await this.marketPricing.initialize();
            await this.dynamicPricing.initialize();
            
            // Lightning Network初期化
            await this.lightning.initialize();
            
            // P2Pネットワーク起動
            await this.p2pNetwork.start();
            
            // GPU検出
            await this.detectLocalGPUs();
            
            // 仮想GPUマネージャー初期化
            await this.vgpuManager.initialize(this.localGPUs);
            
            // イベントリスナー設定
            this.setupEventListeners();
            
            // メトリクス収集開始
            this.metrics.startCollection();
            
            // 定期タスク開始
            this.startPeriodicTasks();
            
            this.initialized = true;
            logger.info('✅ Strawberry Core initialized successfully');
            
            this.emit('initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Strawberry Core:', error);
            throw error;
        }
    }

    async detectLocalGPUs() {
        try {
            const gpus = await this.gpuDetector.detectGPUs();
            
            for (const gpu of gpus) {
                const gpuInfo = {
                    id: gpu.uuid,
                    name: gpu.name,
                    model: gpu.model,
                    vram: gpu.vram,
                    computeCapability: gpu.computeCapability,
                    temperature: gpu.temperature,
                    utilization: gpu.utilization,
                    powerDraw: gpu.powerDraw,
                    status: 'available',
                    performance: await this.benchmarkGPU(gpu),
                    capabilities: {
                        cuda: gpu.cudaCapable,
                        opencl: gpu.openclCapable,
                        vulkan: gpu.vulkanCapable,
                        tensorCores: gpu.tensorCores,
                        raytracing: gpu.raytracingCores > 0
                    }
                };
                
                this.localGPUs.set(gpu.uuid, gpuInfo);
                logger.info(`Detected GPU: ${gpu.name} (${gpu.uuid})`);
            }
            
            return Array.from(this.localGPUs.values());
            
        } catch (error) {
            logger.error('GPU detection failed:', error);
            throw error;
        }
    }

    async benchmarkGPU(gpu) {
        // 簡易ベンチマーク実装
        const benchmarks = {
            fp32: 0,
            fp16: 0,
            int8: 0,
            bandwidth: 0
        };
        
        try {
            // CUDA/OpenCLベンチマーク実行
            if (gpu.cudaCapable) {
                benchmarks.fp32 = await this.runCudaBenchmark(gpu, 'fp32');
                benchmarks.fp16 = await this.runCudaBenchmark(gpu, 'fp16');
                benchmarks.int8 = await this.runCudaBenchmark(gpu, 'int8');
            }
            
            benchmarks.bandwidth = gpu.memoryBandwidth || 0;
            
            // パフォーマンススコア計算
            const score = (benchmarks.fp32 * 0.4) + 
                         (benchmarks.fp16 * 0.3) + 
                         (benchmarks.int8 * 0.2) + 
                         (benchmarks.bandwidth * 0.1);
            
            return {
                score: Math.round(score),
                benchmarks: benchmarks,
                timestamp: Date.now()
            };
            
        } catch (error) {
            logger.error(`Benchmark failed for GPU ${gpu.uuid}:`, error);
            return { score: 0, benchmarks: benchmarks };
        }
    }

    async runCudaBenchmark(gpu, precision) {
        // 実際のCUDAベンチマーク実装はネイティブモジュールが必要
        // ここではGPUスペックに基づく推定値を返す
        const specs = this.marketPricing.getGPUSpecs(gpu.name);
        if (specs && specs.tflops) {
            const multipliers = { fp32: 1, fp16: 2, int8: 4 };
            return specs.tflops * (multipliers[precision] || 1) * (0.9 + Math.random() * 0.2);
        }
        
        return 10 + Math.random() * 20; // デフォルト値
    }

    async startGPULending(gpuId, pricing) {
        const gpu = this.localGPUs.get(gpuId);
        if (!gpu) {
            throw new Error('GPU not found');
        }
        
        if (gpu.status !== 'available') {
            throw new Error(`GPU is ${gpu.status}`);
        }
        
        // 独自価格システムで推奨価格を取得
        const recommendedPrice = await this.getRecommendedPrice(gpu, pricing);
        
        // 価格設定
        const lendingConfig = {
            gpuId: gpuId,
            hourlyRate: pricing.hourlyRate || recommendedPrice.recommendedPrice,
            minimumDuration: pricing.minimumDuration || 1,
            maximumDuration: pricing.maximumDuration || 168,
            autoPricing: pricing.autoPricing || false,
            dynamicPricing: pricing.dynamicPricing !== false, // デフォルトで有効
            instantAvailable: true,
            acceptedCurrencies: ['BTC', 'Lightning'],
            region: await this.getRegion(),
            latencyClass: await this.measureLatencyClass(),
            qualityScore: gpu.performance.score || 100,
            providerReputation: 100 // 新規プロバイダー
        };
        
        // 仮想GPU作成
        const vGPU = await this.vgpuManager.createVirtualGPU(gpu, lendingConfig);
        
        // P2Pネットワークに公開
        await this.p2pNetwork.announceGPU({
            ...vGPU,
            pricing: lendingConfig,
            endpoint: await this.generateSecureEndpoint(gpuId),
            marketPrice: recommendedPrice
        });
        
        // 状態更新
        gpu.status = 'lending';
        this.activeLending.set(gpuId, {
            config: lendingConfig,
            startTime: Date.now(),
            earnings: 0,
            totalRentals: 0,
            vGPU: vGPU,
            priceHistory: []
        });
        
        // データベースに記録
        await this.db.saveLendingRecord({
            gpuId: gpuId,
            config: lendingConfig,
            startTime: new Date()
        });
        
        this.emit('gpu-lending-started', { gpuId, config: lendingConfig });
        logger.info(`Started lending GPU ${gpuId} at $${lendingConfig.hourlyRate}/hour (Market: $${recommendedPrice.currentPrice}/hour)`);
        
        return { gpuId, lendingConfig, vGPU, marketPrice: recommendedPrice };
    }

    async getRecommendedPrice(gpu, userPreferences = {}) {
        // 市場価格を取得
        const marketPrice = this.marketPricing.calculateGPUPrice(gpu.name, {
            region: await this.getRegion(),
            qualityScore: gpu.performance.score || 100
        });
        
        // 目標収益がある場合は推奨価格を計算
        if (userPreferences.targetMonthlyEarnings) {
            return this.marketPricing.recommendPrice(
                gpu.name,
                userPreferences.targetMonthlyEarnings,
                {
                    utilizationRate: userPreferences.expectedUtilization || 0.7
                }
            );
        }
        
        return {
            currentPrice: marketPrice.price.hourly,
            recommendedPrice: marketPrice.price.hourly,
            strategy: 'market',
            marketAnalysis: {
                priceRange: {
                    min: marketPrice.price.hourly * 0.8,
                    max: marketPrice.price.hourly * 1.2
                },
                competitiveness: 'optimal'
            }
        };
    }

    async stopGPULending(gpuId) {
        const gpu = this.localGPUs.get(gpuId);
        const lending = this.activeLending.get(gpuId);
        
        if (!gpu || !lending) {
            throw new Error('GPU not in lending state');
        }
        
        // アクティブなレンタルをチェック
        const activeRental = Array.from(this.activeRentals.values())
            .find(rental => rental.gpuId === gpuId);
        
        if (activeRental) {
            throw new Error('Cannot stop lending while GPU is rented');
        }
        
        // P2Pネットワークから削除
        await this.p2pNetwork.removeGPU(gpuId);
        
        // 仮想GPU削除
        await this.vgpuManager.destroyVirtualGPU(lending.vGPU.id);
        
        // 状態更新
        gpu.status = 'available';
        const finalLending = this.activeLending.get(gpuId);
        this.activeLending.delete(gpuId);
        
        // 最終収益計算
        const duration = (Date.now() - finalLending.startTime) / (1000 * 60 * 60);
        const totalEarnings = finalLending.earnings;
        
        // データベースに記録
        await this.db.updateLendingRecord({
            gpuId: gpuId,
            endTime: new Date(),
            totalEarnings: totalEarnings,
            totalDuration: duration,
            totalRentals: finalLending.totalRentals
        });
        
        this.emit('gpu-lending-stopped', { 
            gpuId, 
            totalEarnings, 
            duration,
            totalRentals: finalLending.totalRentals,
            averagePrice: finalLending.priceHistory.length > 0 ?
                finalLending.priceHistory.reduce((sum, p) => sum + p, 0) / finalLending.priceHistory.length : 0
        });
        
        logger.info(`Stopped lending GPU ${gpuId}. Total earnings: $${totalEarnings.toFixed(2)}`);
        
        return { gpuId, totalEarnings, duration };
    }

    async getAvailableGPUs(filters = {}) {
        try {
            // P2Pネットワークからピアの利用可能なGPUを取得
            const peerGPUs = await this.p2pNetwork.discoverGPUs(filters);
            
            // フィルタリング
            let availableGPUs = peerGPUs.filter(gpu => {
                if (filters.minVRAM && gpu.vram < filters.minVRAM) return false;
                if (filters.maxPrice && gpu.pricing.hourlyRate > filters.maxPrice) return false;
                if (filters.location && gpu.region !== filters.location) return false;
                if (filters.minPerformance && gpu.performance.score < filters.minPerformance) return false;
                return true;
            });
            
            // レイテンシ測定と価格分析
            availableGPUs = await Promise.all(availableGPUs.map(async gpu => {
                const latency = await this.p2pNetwork.measureLatency(gpu.peerId);
                
                // 市場価格との比較
                const marketPrice = this.marketPricing.calculateGPUPrice(gpu.name, {
                    region: gpu.region
                });
                
                return { 
                    ...gpu, 
                    latency,
                    marketComparison: {
                        marketPrice: marketPrice.price.hourly,
                        discount: ((marketPrice.price.hourly - gpu.pricing.hourlyRate) / marketPrice.price.hourly) * 100,
                        value: gpu.pricing.hourlyRate <= marketPrice.price.hourly ? 'good' : 'premium'
                    }
                };
            }));
            
            // 価値順でソート（価格と性能のバランス）
            availableGPUs.sort((a, b) => {
                const valueA = (a.performance.score || 50) / a.pricing.hourlyRate;
                const valueB = (b.performance.score || 50) / b.pricing.hourlyRate;
                return valueB - valueA;
            });
            
            // キャッシュ更新
            availableGPUs.forEach(gpu => {
                this.peerGPUs.set(gpu.id, gpu);
            });
            
            return availableGPUs;
            
        } catch (error) {
            logger.error('Failed to get available GPUs:', error);
            throw error;
        }
    }

    async rentGPU(gpuId, duration = 1) {
        const gpu = this.peerGPUs.get(gpuId);
        if (!gpu) {
            throw new Error('GPU not found');
        }
        
        // 動的価格が有効な場合は最新価格を取得
        let finalPrice = gpu.pricing.hourlyRate;
        if (gpu.pricing.dynamicPricing) {
            const dynamicPrice = await this.dynamicPricing.calculateDynamicPrice(
                gpuId,
                gpu.name,
                {
                    duration: duration,
                    region: gpu.region,
                    urgency: 'normal',
                    quality: gpu.qualityScore || 100,
                    currentSupply: 10, // 実際の実装では取得
                    currentDemand: 15  // 実際の実装では取得
                }
            );
            finalPrice = dynamicPrice.pricing.dynamic;
        }
        
        // 料金計算
        const totalCost = finalPrice * duration;
        const platformFee = totalCost * this.platformFeeRate;
        const providerPayment = totalCost - platformFee;
        
        // Lightning Network請求書作成
        const invoice = await this.lightning.createInvoice(
            totalCost,
            `GPU Rental: ${gpu.name} for ${duration} hours`
        );
        
        // レンタル記録作成
        const rentalId = this.generateRentalId();
        const rental = {
            id: rentalId,
            gpuId: gpuId,
            gpu: gpu,
            duration: duration,
            startTime: Date.now(),
            endTime: Date.now() + (duration * 60 * 60 * 1000),
            hourlyRate: finalPrice,
            totalCost: totalCost,
            platformFee: platformFee,
            providerPayment: providerPayment,
            invoice: invoice,
            status: 'pending_payment',
            accessCredentials: null,
            priceType: gpu.pricing.dynamicPricing ? 'dynamic' : 'fixed',
            marketPrice: gpu.marketComparison?.marketPrice || finalPrice
        };
        
        this.activeRentals.set(rentalId, rental);
        
        // 支払い監視
        this.lightning.on(`payment:${invoice.paymentHash}`, async (payment) => {
            rental.status = 'active';
            rental.paymentTime = Date.now();
            
            // GPU接続情報取得
            const accessInfo = await this.p2pNetwork.requestGPUAccess(gpu.peerId, {
                rentalId: rentalId,
                duration: duration,
                paymentProof: payment.preimage
            });
            
            rental.accessCredentials = accessInfo.credentials;
            
            // プロバイダーへの支払い
            await this.lightning.sendPayment(
                gpu.paymentRequest,
                providerPayment
            );
            
            // データベースに記録
            await this.db.saveRentalRecord(rental);
            
            // メトリクス更新
            this.metrics.recordRentalMetrics({
                gpu_model: gpu.name,
                region: gpu.region,
                price_per_hour: finalPrice,
                duration_hours: duration,
                revenue: totalCost,
                payment_method: 'lightning'
            });
            
            this.emit('gpu-rental-started', rental);
            logger.info(`GPU rental started: ${rentalId} at $${finalPrice}/hour (Market: $${rental.marketPrice}/hour)`);
        });
        
        // タイムアウト設定
        setTimeout(() => {
            if (rental.status === 'pending_payment') {
                this.activeRentals.delete(rentalId);
                this.emit('gpu-rental-timeout', rentalId);
            }
        }, 10 * 60 * 1000); // 10分
        
        return {
            rentalId: rentalId,
            invoice: invoice.paymentRequest,
            amount: totalCost,
            duration: duration,
            hourlyRate: finalPrice,
            savings: gpu.marketComparison ? {
                amount: (gpu.marketComparison.marketPrice - finalPrice) * duration,
                percentage: gpu.marketComparison.discount
            } : null,
            gpu: {
                id: gpu.id,
                name: gpu.name,
                performance: gpu.performance
            }
        };
    }

    async stopGPURental(rentalId) {
        const rental = this.activeRentals.get(rentalId);
        if (!rental) {
            throw new Error('Rental not found');
        }
        
        if (rental.status !== 'active') {
            throw new Error('Rental is not active');
        }
        
        // 使用時間計算
        const usedHours = (Date.now() - rental.startTime) / (1000 * 60 * 60);
        const refundHours = Math.max(0, rental.duration - usedHours);
        const refundAmount = refundHours * rental.hourlyRate;
        
        // GPU接続終了
        await this.p2pNetwork.releaseGPUAccess(rental.gpu.peerId, {
            rentalId: rentalId,
            endTime: Date.now()
        });
        
        // 返金処理（必要な場合）
        if (refundAmount > 0.01) { // 最小返金額
            const refundInvoice = await this.lightning.createInvoice(
                refundAmount,
                `Refund for rental ${rentalId}`
            );
            
            rental.refund = {
                amount: refundAmount,
                invoice: refundInvoice.paymentRequest,
                status: 'pending'
            };
        }
        
        // 状態更新
        rental.status = 'completed';
        rental.actualEndTime = Date.now();
        rental.actualDuration = usedHours;
        
        // データベース更新
        await this.db.updateRentalRecord(rental);
        
        this.activeRentals.delete(rentalId);
        
        this.emit('gpu-rental-stopped', {
            rentalId: rentalId,
            actualDuration: usedHours,
            refundAmount: refundAmount
        });
        
        logger.info(`GPU rental stopped: ${rentalId}, used ${usedHours.toFixed(2)} hours`);
        
        return {
            rentalId: rentalId,
            actualDuration: usedHours,
            totalCost: rental.totalCost,
            actualCost: rental.hourlyRate * usedHours,
            refund: rental.refund
        };
    }

    async getSystemStats() {
        const stats = {
            localGPUs: {
                total: this.localGPUs.size,
                available: Array.from(this.localGPUs.values()).filter(g => g.status === 'available').length,
                lending: this.activeLending.size,
                details: Array.from(this.localGPUs.values()).map(gpu => ({
                    id: gpu.id,
                    name: gpu.name,
                    status: gpu.status,
                    utilization: gpu.utilization,
                    temperature: gpu.temperature
                }))
            },
            activeRentals: {
                total: this.activeRentals.size,
                totalValue: Array.from(this.activeRentals.values())
                    .reduce((sum, rental) => sum + rental.totalCost, 0),
                details: Array.from(this.activeRentals.values()).map(rental => ({
                    id: rental.id,
                    gpuName: rental.gpu.name,
                    duration: rental.duration,
                    status: rental.status,
                    remainingTime: Math.max(0, rental.endTime - Date.now()) / (1000 * 60 * 60),
                    priceType: rental.priceType
                }))
            },
            activeLending: {
                total: this.activeLending.size,
                totalEarnings: Array.from(this.activeLending.values())
                    .reduce((sum, lending) => sum + lending.earnings, 0),
                details: Array.from(this.activeLending.values()).map((lending, gpuId) => ({
                    gpuId: gpuId,
                    hourlyRate: lending.config.hourlyRate,
                    totalRentals: lending.totalRentals,
                    earnings: lending.earnings,
                    uptime: (Date.now() - lending.startTime) / (1000 * 60 * 60)
                }))
            },
            network: {
                connectedPeers: this.p2pNetwork.getConnectedPeers().length,
                availableGPUs: this.peerGPUs.size,
                totalBandwidth: await this.p2pNetwork.getTotalBandwidth()
            },
            lightning: {
                nodeInfo: await this.lightning.getNodeInfo(),
                channelBalance: await this.lightning.getChannelBalance(),
                pendingPayments: await this.lightning.getPendingPayments()
            },
            pricing: {
                marketAnalysis: this.marketPricing.analyzeMarket(),
                statistics: this.marketPricing.statistics
            },
            system: {
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage(),
                platform: process.platform,
                nodeVersion: process.version
            }
        };
        
        return stats;
    }

    async getMarketAnalysis() {
        // 市場分析を提供
        const analysis = this.marketPricing.analyzeMarket();
        
        // 動的価格の統計も追加
        const dynamicStats = {
            priceVolatility: this.dynamicPricing.statistics,
            optimalPrices: {}
        };
        
        // 各GPU モデルの最適価格を計算
        for (const gpu of analysis.topGPUs) {
            const optimization = await this.dynamicPricing.optimizeRevenue(
                gpu.gpu,
                { targetUtilization: 0.8 }
            );
            
            if (optimization) {
                dynamicStats.optimalPrices[gpu.gpu] = {
                    current: gpu.average,
                    optimal: optimization.averagePrice,
                    expectedRevenue: optimization.totalExpectedRevenue
                };
            }
        }
        
        return {
            market: analysis,
            dynamic: dynamicStats,
            recommendations: this.generateMarketRecommendations(analysis)
        };
    }

    generateMarketRecommendations(analysis) {
        const recommendations = [];
        
        // 高需要GPUの推奨
        const highDemandGPUs = analysis.topGPUs.slice(0, 3);
        recommendations.push({
            type: 'high_demand',
            message: `High demand for ${highDemandGPUs.map(g => g.gpu).join(', ')}. Consider listing these GPUs.`,
            gpus: highDemandGPUs
        });
        
        // 価格競争力のある地域
        const competitiveRegions = Object.entries(analysis.regionAnalysis)
            .filter(([region, data]) => data.averagePrice < analysis.statistics.averagePrice)
            .map(([region, data]) => region);
        
        if (competitiveRegions.length > 0) {
            recommendations.push({
                type: 'competitive_regions',
                message: `Better pricing available in ${competitiveRegions.join(', ')}`,
                regions: competitiveRegions
            });
        }
        
        return recommendations;
    }

    setupEventListeners() {
        // P2Pネットワークイベント
        this.p2pNetwork.on('peer:connected', (peer) => {
            logger.info(`New peer connected: ${peer.id}`);
            this.emit('peer:connected', peer);
        });
        
        this.p2pNetwork.on('gpu:announced', (gpu) => {
            this.peerGPUs.set(gpu.id, gpu);
            this.emit('gpu:available', gpu);
        });
        
        this.p2pNetwork.on('gpu:removed', (gpuId) => {
            this.peerGPUs.delete(gpuId);
            this.emit('gpu:unavailable', gpuId);
        });
        
        // GPUモニタリング
        this.gpuDetector.on('gpu:status:changed', (gpuId, status) => {
            const gpu = this.localGPUs.get(gpuId);
            if (gpu) {
                gpu.status = status;
                this.emit('gpu:status:changed', { gpuId, status });
            }
        });
        
        // Lightning Networkイベント
        this.lightning.on('invoice:paid', (invoice) => {
            logger.info(`Invoice paid: ${invoice.paymentHash}`);
            this.emit('payment:received', invoice);
        });
        
        // 価格エンジンイベント
        this.dynamicPricing.on('price-updated', (update) => {
            const lending = this.activeLending.get(update.gpuId);
            if (lending) {
                lending.config.hourlyRate = update.newPrice.pricing.dynamic;
                lending.priceHistory.push(update.newPrice.pricing.dynamic);
                this.emit('price:updated', update);
            }
        });
    }

    startPeriodicTasks() {
        // GPU状態更新（30秒ごと）
        setInterval(async () => {
            for (const [gpuId, gpu] of this.localGPUs) {
                try {
                    const status = await this.gpuDetector.getGPUStatus(gpuId);
                    gpu.temperature = status.temperature;
                    gpu.utilization = status.utilization;
                    gpu.powerDraw = status.powerDraw;
                    
                    // 温度警告
                    if (gpu.temperature > 85) {
                        this.emit('gpu:warning', {
                            gpuId: gpuId,
                            type: 'temperature',
                            value: gpu.temperature
                        });
                    }
                } catch (error) {
                    logger.error(`Failed to update GPU ${gpuId} status:`, error);
                }
            }
        }, 30000);
        
        // レンタル期限チェック（1分ごと）
        setInterval(() => {
            const now = Date.now();
            for (const [rentalId, rental] of this.activeRentals) {
                if (rental.status === 'active' && now >= rental.endTime) {
                    this.stopGPURental(rentalId).catch(error => {
                        logger.error(`Failed to stop expired rental ${rentalId}:`, error);
                    });
                }
            }
        }, 60000);
        
        // 収益更新（5分ごと）
        setInterval(() => {
            for (const [gpuId, lending] of this.activeLending) {
                const activeRental = Array.from(this.activeRentals.values())
                    .find(r => r.gpuId === gpuId && r.status === 'active');
                
                if (activeRental) {
                    const earnedMinutes = 5;
                    const earned = (activeRental.hourlyRate / 60) * earnedMinutes;
                    lending.earnings += earned;
                    
                    this.emit('earnings:updated', {
                        gpuId: gpuId,
                        earned: earned,
                        total: lending.earnings
                    });
                }
            }
        }, 5 * 60 * 1000);
        
        // 価格更新（動的価格が有効な場合）
        setInterval(async () => {
            for (const [gpuId, lending] of this.activeLending) {
                if (lending.config.dynamicPricing) {
                    await this.dynamicPricing.updatePricesRealtime();
                }
            }
        }, 5 * 60 * 1000);
        
        // メトリクス送信（1分ごと）
        setInterval(async () => {
            const stats = await this.getSystemStats();
            this.metrics.recordSystemStats(stats);
        }, 60000);
    }

    async getRegion() {
        // IPベースの地域検出
        try {
            const response = await fetch('https://ipapi.co/json/');
            const data = await response.json();
            return data.region_code || 'US-EAST';
        } catch (error) {
            return 'UNKNOWN';
        }
    }

    async measureLatencyClass() {
        // ネットワークレイテンシクラス測定
        const testEndpoints = [
            { region: 'us-east-1', endpoint: 'ping.strawberry.network' },
            { region: 'eu-west-1', endpoint: 'eu.ping.strawberry.network' },
            { region: 'ap-south-1', endpoint: 'ap.ping.strawberry.network' }
        ];
        
        const latencies = await Promise.all(testEndpoints.map(async test => {
            const start = Date.now();
            try {
                await fetch(`https://${test.endpoint}/ping`, { 
                    method: 'HEAD',
                    signal: AbortSignal.timeout(5000)
                });
                return Date.now() - start;
            } catch {
                return 999999;
            }
        }));
        
        const avgLatency = latencies.reduce((a, b) => a + b) / latencies.length;
        
        if (avgLatency < 10) return 'ultra-low';
        if (avgLatency < 50) return 'low';
        if (avgLatency < 100) return 'medium';
        return 'high';
    }

    generateRentalId() {
        return `rental-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async generateSecureEndpoint(gpuId) {
        // セキュアなGPUアクセスエンドポイント生成
        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        
        return {
            url: `wss://gpu.strawberry.network/${gpuId}`,
            token: token,
            expires: Date.now() + (24 * 60 * 60 * 1000) // 24時間
        };
    }

    async createInvoice(amount, description) {
        return await this.lightning.createInvoice(amount, description);
    }

    async payInvoice(paymentRequest) {
        return await this.lightning.sendPayment(paymentRequest);
    }

    async getHistory(options = {}) {
        const { type, limit = 50, offset = 0 } = options;
        
        if (type === 'rentals') {
            return await this.db.getRentalHistory(limit, offset);
        } else if (type === 'lending') {
            return await this.db.getLendingHistory(limit, offset);
        } else {
            // 両方の履歴を結合
            const rentals = await this.db.getRentalHistory(limit / 2, offset / 2);
            const lending = await this.db.getLendingHistory(limit / 2, offset / 2);
            
            return [...rentals, ...lending]
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, limit);
        }
    }

    async shutdown() {
        logger.info('Shutting down Strawberry Core...');
        
        try {
            // アクティブなレンタルを安全に終了
            for (const [rentalId, rental] of this.activeRentals) {
                if (rental.status === 'active') {
                    await this.stopGPURental(rentalId);
                }
            }
            
            // GPU貸出を停止
            for (const gpuId of this.activeLending.keys()) {
                await this.stopGPULending(gpuId);
            }
            
            // 各コンポーネントのシャットダウン
            await this.p2pNetwork.stop();
            await this.lightning.shutdown();
            await this.vgpuManager.shutdown();
            await this.db.disconnect();
            
            this.metrics.stopCollection();
            
            logger.info('✅ Strawberry Core shutdown complete');
            
        } catch (error) {
            logger.error('Error during shutdown:', error);
            throw error;
        }
    }
}

module.exports = { StrawberryCore };