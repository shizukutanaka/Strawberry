// src/core/market-pricing-engine.js - 独自の市場価格決定エンジン
const EventEmitter = require('events');
const { logger } = require('../utils/logger');

class MarketPricingEngine extends EventEmitter {
    constructor() {
        super();
        
        // GPU性能ベースの基準価格（TFLOPS単位）
        this.performanceBasePricing = {
            tflopsRate: 0.015, // $0.015 per TFLOPS per hour
            vramRate: 0.00002, // $0.00002 per MB VRAM per hour
            tensorCoreBonus: 1.3, // 30% bonus for tensor cores
            rtCoreBonus: 1.2, // 20% bonus for RT cores
        };
        
        // 地域別コスト係数
        this.regionCostFactors = {
            'US-EAST': { electricity: 0.12, internet: 1.0, demand: 1.1 },
            'US-WEST': { electricity: 0.15, internet: 1.0, demand: 1.2 },
            'EU-WEST': { electricity: 0.25, internet: 0.95, demand: 1.0 },
            'EU-CENTRAL': { electricity: 0.28, internet: 0.95, demand: 0.95 },
            'ASIA-PACIFIC': { electricity: 0.18, internet: 0.90, demand: 1.3 },
            'ASIA-SOUTH': { electricity: 0.08, internet: 0.85, demand: 0.9 },
            'LATAM': { electricity: 0.10, internet: 0.80, demand: 0.8 },
            'AFRICA': { electricity: 0.15, internet: 0.75, demand: 0.7 }
        };
        
        // GPUアーキテクチャ性能マップ
        this.gpuPerformanceMap = {
            // NVIDIA
            'RTX 4090': { tflops: 82.58, vram: 24576, hasTensorCores: true, hasRTCores: true },
            'RTX 4080': { tflops: 48.74, vram: 16384, hasTensorCores: true, hasRTCores: true },
            'RTX 4070 Ti': { tflops: 40.09, vram: 12288, hasTensorCores: true, hasRTCores: true },
            'RTX 4070': { tflops: 29.15, vram: 12288, hasTensorCores: true, hasRTCores: true },
            'RTX 4060 Ti': { tflops: 22.06, vram: 8192, hasTensorCores: true, hasRTCores: true },
            'RTX 3090': { tflops: 35.58, vram: 24576, hasTensorCores: true, hasRTCores: true },
            'RTX 3080': { tflops: 29.77, vram: 10240, hasTensorCores: true, hasRTCores: true },
            'RTX 3070': { tflops: 20.31, vram: 8192, hasTensorCores: true, hasRTCores: true },
            'RTX 3060 Ti': { tflops: 16.20, vram: 8192, hasTensorCores: true, hasRTCores: true },
            'RTX 3060': { tflops: 13.04, vram: 12288, hasTensorCores: true, hasRTCores: true },
            
            // AMD
            'RX 7900 XTX': { tflops: 61.42, vram: 24576, hasTensorCores: false, hasRTCores: true },
            'RX 7900 XT': { tflops: 51.61, vram: 20480, hasTensorCores: false, hasRTCores: true },
            'RX 7800 XT': { tflops: 37.32, vram: 16384, hasTensorCores: false, hasRTCores: true },
            'RX 7700 XT': { tflops: 35.17, vram: 12288, hasTensorCores: false, hasRTCores: true },
            'RX 7600': { tflops: 21.75, vram: 8192, hasTensorCores: false, hasRTCores: true },
            'RX 6900 XT': { tflops: 23.04, vram: 16384, hasTensorCores: false, hasRTCores: true },
            'RX 6800 XT': { tflops: 20.74, vram: 16384, hasTensorCores: false, hasRTCores: true },
            'RX 6700 XT': { tflops: 13.21, vram: 12288, hasTensorCores: false, hasRTCores: true },
            
            // Intel
            'Arc A770': { tflops: 19.66, vram: 16384, hasTensorCores: true, hasRTCores: true },
            'Arc A750': { tflops: 17.20, vram: 8192, hasTensorCores: true, hasRTCores: true },
            'Arc A580': { tflops: 14.72, vram: 8192, hasTensorCores: true, hasRTCores: true },
            'Arc A380': { tflops: 4.92, vram: 6144, hasTensorCores: true, hasRTCores: true }
        };
        
        // 設定
        this.config = {
            updateInterval: 300000, // 5分
            priceFloor: 0.10, // 最低価格 $0.10/hour
            priceCeiling: 5.00, // 最高価格 $5.00/hour
            profitMargin: 1.25, // 25%の利益マージン
            cacheTimeout: 600000 // 10分
        };
        
        // キャッシュ
        this.priceCache = new Map();
        this.marketData = {
            supply: new Map(),
            demand: new Map(),
            averagePrices: new Map()
        };
        
        // 統計
        this.statistics = {
            totalCalculations: 0,
            averagePrice: 0,
            priceRange: { min: 999, max: 0 }
        };
    }

    async initialize() {
        try {
            logger.info('Initializing Market Pricing Engine...');
            
            // 定期更新開始
            this.startPeriodicUpdates();
            
            logger.info('✅ Market Pricing Engine initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Market Pricing Engine:', error);
        }
    }

    /**
     * GPU価格を計算（独自アルゴリズム）
     */
    calculateGPUPrice(gpuModel, options = {}) {
        const {
            region = 'US-EAST',
            utilizationRate = 0.8,
            qualityScore = 100,
            demandLevel = 1.0,
            supplyLevel = 1.0,
            timeOfDay = new Date().getHours(),
            rentalDuration = 1 // hours
        } = options;
        
        // GPUスペック取得
        const gpuSpecs = this.getGPUSpecs(gpuModel);
        if (!gpuSpecs) {
            logger.warn(`Unknown GPU model: ${gpuModel}`);
            return this.getDefaultPrice();
        }
        
        // 基本価格計算（性能ベース）
        let basePrice = this.calculateBasePrice(gpuSpecs);
        
        // 地域調整
        const regionFactor = this.calculateRegionFactor(region);
        basePrice *= regionFactor;
        
        // 需給調整
        const supplyDemandFactor = this.calculateSupplyDemandFactor(demandLevel, supplyLevel);
        basePrice *= supplyDemandFactor;
        
        // 時間帯調整
        const timeFactor = this.calculateTimeFactor(timeOfDay);
        basePrice *= timeFactor;
        
        // 品質調整
        const qualityFactor = this.calculateQualityFactor(qualityScore);
        basePrice *= qualityFactor;
        
        // 長期レンタル割引
        const durationDiscount = this.calculateDurationDiscount(rentalDuration);
        basePrice *= durationDiscount;
        
        // 利益マージン適用
        basePrice *= this.config.profitMargin;
        
        // 価格制限適用
        const finalPrice = Math.max(
            this.config.priceFloor,
            Math.min(this.config.priceCeiling, basePrice)
        );
        
        // 統計更新
        this.updateStatistics(finalPrice);
        
        // キャッシュ保存
        const cacheKey = `${gpuModel}-${region}-${Math.floor(timeOfDay/4)}`;
        this.priceCache.set(cacheKey, {
            price: finalPrice,
            timestamp: Date.now()
        });
        
        const result = {
            gpuModel: gpuModel,
            price: {
                hourly: finalPrice,
                daily: finalPrice * 24 * 0.95, // 5%割引
                weekly: finalPrice * 168 * 0.85, // 15%割引
                monthly: finalPrice * 720 * 0.70 // 30%割引
            },
            factors: {
                base: this.calculateBasePrice(gpuSpecs),
                region: regionFactor,
                supplyDemand: supplyDemandFactor,
                time: timeFactor,
                quality: qualityFactor,
                duration: durationDiscount
            },
            breakdown: {
                performanceCost: gpuSpecs.tflops * this.performanceBasePricing.tflopsRate,
                memoryCost: gpuSpecs.vram * this.performanceBasePricing.vramRate,
                featureCost: this.calculateFeatureCost(gpuSpecs),
                operationalCost: this.calculateOperationalCost(region)
            },
            metadata: {
                timestamp: Date.now(),
                region: region,
                cacheKey: cacheKey
            }
        };
        
        this.emit('price-calculated', result);
        
        return result;
    }

    /**
     * 基本価格計算（性能ベース）
     */
    calculateBasePrice(gpuSpecs) {
        let price = 0;
        
        // TFLOPS基準
        price += gpuSpecs.tflops * this.performanceBasePricing.tflopsRate;
        
        // VRAM基準
        price += gpuSpecs.vram * this.performanceBasePricing.vramRate;
        
        // 特殊機能ボーナス
        if (gpuSpecs.hasTensorCores) {
            price *= this.performanceBasePricing.tensorCoreBonus;
        }
        
        if (gpuSpecs.hasRTCores) {
            price *= this.performanceBasePricing.rtCoreBonus;
        }
        
        return price;
    }

    /**
     * 地域係数計算
     */
    calculateRegionFactor(region) {
        const regionData = this.regionCostFactors[region] || this.regionCostFactors['US-EAST'];
        
        // 電力コストの影響（30%）
        const electricityFactor = 1 + (regionData.electricity - 0.15) * 2;
        
        // インターネットコストの影響（20%）
        const internetFactor = regionData.internet;
        
        // 地域需要の影響（50%）
        const demandFactor = regionData.demand;
        
        return (electricityFactor * 0.3 + internetFactor * 0.2 + demandFactor * 0.5);
    }

    /**
     * 需給係数計算
     */
    calculateSupplyDemandFactor(demand, supply) {
        const ratio = demand / (supply || 1);
        
        if (ratio > 2.0) {
            // 需要過多：最大50%値上げ
            return 1.0 + Math.min((ratio - 2.0) * 0.25, 0.5);
        } else if (ratio < 0.5) {
            // 供給過多：最大30%値下げ
            return 0.7 + ratio * 0.6;
        } else {
            // バランス状態：微調整
            return 0.9 + ratio * 0.1;
        }
    }

    /**
     * 時間帯係数計算
     */
    calculateTimeFactor(hour) {
        // ビジネスアワー（9-17時）は需要高
        if (hour >= 9 && hour <= 17) {
            return 1.2;
        }
        // 深夜（2-6時）は需要低
        else if (hour >= 2 && hour <= 6) {
            return 0.8;
        }
        // ゲームプライムタイム（19-23時）
        else if (hour >= 19 && hour <= 23) {
            return 1.1;
        }
        // その他
        return 1.0;
    }

    /**
     * 品質係数計算
     */
    calculateQualityFactor(qualityScore) {
        // 0-100のスコアを0.8-1.2の係数に変換
        return 0.8 + (qualityScore / 100) * 0.4;
    }

    /**
     * 期間割引計算
     */
    calculateDurationDiscount(hours) {
        if (hours >= 720) return 0.70;      // 1ヶ月以上：30%割引
        if (hours >= 168) return 0.85;      // 1週間以上：15%割引
        if (hours >= 24) return 0.95;       // 1日以上：5%割引
        if (hours >= 8) return 0.98;        // 8時間以上：2%割引
        return 1.0;
    }

    /**
     * 特殊機能コスト計算
     */
    calculateFeatureCost(gpuSpecs) {
        let cost = 0;
        
        if (gpuSpecs.hasTensorCores) {
            cost += 0.05; // $0.05/hour for AI acceleration
        }
        
        if (gpuSpecs.hasRTCores) {
            cost += 0.03; // $0.03/hour for ray tracing
        }
        
        // 大容量VRAMボーナス
        if (gpuSpecs.vram >= 16384) {
            cost += 0.02; // $0.02/hour for 16GB+ VRAM
        }
        
        if (gpuSpecs.vram >= 24576) {
            cost += 0.03; // Additional $0.03/hour for 24GB+ VRAM
        }
        
        return cost;
    }

    /**
     * 運用コスト計算
     */
    calculateOperationalCost(region) {
        const regionData = this.regionCostFactors[region] || this.regionCostFactors['US-EAST'];
        
        // 基本運用コスト
        let cost = 0.05; // $0.05/hour base
        
        // 電力コスト調整
        cost += regionData.electricity * 0.2;
        
        // インターネットコスト調整
        cost *= regionData.internet;
        
        return cost;
    }

    /**
     * GPUスペック取得
     */
    getGPUSpecs(gpuModel) {
        // 完全一致
        if (this.gpuPerformanceMap[gpuModel]) {
            return this.gpuPerformanceMap[gpuModel];
        }
        
        // 部分一致
        for (const [model, specs] of Object.entries(this.gpuPerformanceMap)) {
            if (gpuModel.includes(model) || model.includes(gpuModel)) {
                return specs;
            }
        }
        
        // デフォルト値（不明なGPU）
        return {
            tflops: 10,
            vram: 8192,
            hasTensorCores: false,
            hasRTCores: false
        };
    }

    /**
     * デフォルト価格
     */
    getDefaultPrice() {
        return {
            gpuModel: 'Unknown',
            price: {
                hourly: 0.30,
                daily: 6.50,
                weekly: 40.00,
                monthly: 150.00
            },
            factors: {
                base: 0.30,
                region: 1.0,
                supplyDemand: 1.0,
                time: 1.0,
                quality: 1.0,
                duration: 1.0
            }
        };
    }

    /**
     * 市場分析
     */
    analyzeMarket() {
        const analysis = {
            timestamp: Date.now(),
            statistics: this.statistics,
            priceRanges: {},
            topGPUs: [],
            regionAnalysis: {}
        };
        
        // GPU別価格レンジ
        for (const [gpu, specs] of Object.entries(this.gpuPerformanceMap)) {
            const prices = [];
            
            // 各地域での価格計算
            for (const region of Object.keys(this.regionCostFactors)) {
                const result = this.calculateGPUPrice(gpu, { region });
                prices.push(result.price.hourly);
            }
            
            analysis.priceRanges[gpu] = {
                min: Math.min(...prices),
                max: Math.max(...prices),
                average: prices.reduce((a, b) => a + b) / prices.length
            };
        }
        
        // トップGPU（価格順）
        const sortedGPUs = Object.entries(analysis.priceRanges)
            .sort((a, b) => b[1].average - a[1].average)
            .slice(0, 10)
            .map(([gpu, prices]) => ({ gpu, ...prices }));
        
        analysis.topGPUs = sortedGPUs;
        
        // 地域別分析
        for (const [region, factors] of Object.entries(this.regionCostFactors)) {
            const regionalPrices = [];
            
            for (const gpu of Object.keys(this.gpuPerformanceMap)) {
                const result = this.calculateGPUPrice(gpu, { region });
                regionalPrices.push(result.price.hourly);
            }
            
            analysis.regionAnalysis[region] = {
                averagePrice: regionalPrices.reduce((a, b) => a + b) / regionalPrices.length,
                factors: factors
            };
        }
        
        return analysis;
    }

    /**
     * 収益予測
     */
    predictEarnings(gpuModel, hours, options = {}) {
        const priceInfo = this.calculateGPUPrice(gpuModel, options);
        
        let totalCost;
        if (hours >= 720) {
            totalCost = priceInfo.price.monthly * (hours / 720);
        } else if (hours >= 168) {
            totalCost = priceInfo.price.weekly * (hours / 168);
        } else if (hours >= 24) {
            totalCost = priceInfo.price.daily * (hours / 24);
        } else {
            totalCost = priceInfo.price.hourly * hours;
        }
        
        const earnings = {
            gross: totalCost,
            platformFee: totalCost * 0.015, // 1.5%プラットフォーム手数料
            net: totalCost * 0.985,
            hours: hours,
            hourlyRate: priceInfo.price.hourly,
            priceBreakdown: priceInfo.breakdown,
            projections: {
                daily: priceInfo.price.hourly * 24 * 0.985 * (options.utilizationRate || 0.8),
                weekly: priceInfo.price.weekly * 0.985 * (options.utilizationRate || 0.8),
                monthly: priceInfo.price.monthly * 0.985 * (options.utilizationRate || 0.8)
            }
        };
        
        return earnings;
    }

    /**
     * 価格推奨
     */
    recommendPrice(gpuModel, targetEarnings, options = {}) {
        const basePrice = this.calculateGPUPrice(gpuModel, options);
        const currentHourlyRate = basePrice.price.hourly;
        
        // 目標収益達成に必要な稼働率
        const requiredUtilization = targetEarnings / (currentHourlyRate * 24 * 30 * 0.985);
        
        let recommendedPrice = currentHourlyRate;
        let strategy = 'optimal';
        
        if (requiredUtilization > 0.9) {
            // 稼働率が高すぎる場合は価格を上げる
            recommendedPrice = currentHourlyRate * 1.1;
            strategy = 'premium';
        } else if (requiredUtilization < 0.5) {
            // 稼働率が低い場合は価格を下げる
            recommendedPrice = currentHourlyRate * 0.9;
            strategy = 'competitive';
        }
        
        return {
            currentPrice: currentHourlyRate,
            recommendedPrice: recommendedPrice,
            strategy: strategy,
            expectedUtilization: Math.min(requiredUtilization, 1.0),
            expectedEarnings: recommendedPrice * 24 * 30 * Math.min(requiredUtilization, 1.0) * 0.985,
            targetEarnings: targetEarnings
        };
    }

    /**
     * 統計更新
     */
    updateStatistics(price) {
        this.statistics.totalCalculations++;
        
        this.statistics.averagePrice = 
            (this.statistics.averagePrice * (this.statistics.totalCalculations - 1) + price) / 
            this.statistics.totalCalculations;
        
        if (price < this.statistics.priceRange.min) {
            this.statistics.priceRange.min = price;
        }
        
        if (price > this.statistics.priceRange.max) {
            this.statistics.priceRange.max = price;
        }
    }

    /**
     * 定期更新
     */
    startPeriodicUpdates() {
        setInterval(() => {
            // キャッシュクリーンアップ
            const now = Date.now();
            for (const [key, cached] of this.priceCache) {
                if (now - cached.timestamp > this.config.cacheTimeout) {
                    this.priceCache.delete(key);
                }
            }
            
            // 市場データ更新（実装は実際のデータソースに依存）
            this.updateMarketData();
            
        }, this.config.updateInterval);
    }

    /**
     * 市場データ更新
     */
    updateMarketData() {
        // 実際の実装では、内部データベースやP2Pネットワークから
        // 需給データを収集して更新
        logger.debug('Market data updated');
    }

    /**
     * 価格履歴取得
     */
    getPriceHistory(gpuModel, days = 7) {
        // 実際の実装ではデータベースから取得
        const history = [];
        const now = Date.now();
        
        for (let i = 0; i < days * 24; i++) {
            const timestamp = now - (i * 60 * 60 * 1000);
            const hour = new Date(timestamp).getHours();
            
            const price = this.calculateGPUPrice(gpuModel, {
                timeOfDay: hour
            });
            
            history.push({
                timestamp: timestamp,
                price: price.price.hourly
            });
        }
        
        return history.reverse();
    }
}

module.exports = { MarketPricingEngine };