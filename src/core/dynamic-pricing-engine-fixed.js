// src/core/dynamic-pricing-engine-v2.js - 動的価格エンジン（独自アルゴリズム）
const EventEmitter = require('events');
const { logger } = require('../utils/logger');
const tf = require('@tensorflow/tfjs-node');

class DynamicPricingEngine extends EventEmitter {
    constructor(database, marketPricingEngine) {
        super();
        this.db = database;
        this.marketPricing = marketPricingEngine; // MarketPricingEngineを使用
        
        // 価格設定パラメータ
        this.config = {
            baseUpdateInterval: 300000, // 5分
            emergencyUpdateInterval: 60000, // 1分（緊急時）
            priceFloor: 0.8, // 最低価格係数（基準価格比）
            priceCeiling: 2.0, // 最高価格係数
            volatilityThreshold: 0.1, // 10%の変動で緊急更新
            learningRate: 0.01, // ML学習率
            profitMargin: 0.015 // 1.5%プラットフォーム手数料
        };
        
        // 市場データ
        this.marketData = {
            supply: new Map(), // GPU供給量
            demand: new Map(), // GPU需要量
            utilization: new Map(), // GPU利用率
            historicalPrices: new Map(), // 価格履歴
            marketTrends: new Map() // 市場トレンド
        };
        
        // 価格調整係数
        this.factors = {
            supply: 1.0,
            demand: 1.0,
            time: 1.0,
            quality: 1.0,
            region: 1.0,
            reputation: 1.0
        };
        
        // 機械学習モデル
        this.pricingModel = null;
        this.demandForecastModel = null;
        
        // 統計
        this.statistics = {
            totalAdjustments: 0,
            averagePrice: 0,
            revenueOptimization: 0,
            accuracyScore: 0
        };
    }

    async initialize() {
        try {
            logger.info('Initializing Dynamic Pricing Engine...');
            
            // 履歴データ読み込み
            await this.loadHistoricalData();
            
            // MLモデル初期化
            await this.initializeMLModels();
            
            // 定期更新開始
            this.startPeriodicUpdates();
            
            logger.info('✅ Dynamic Pricing Engine initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Dynamic Pricing Engine:', error);
        }
    }

    /**
     * GPU価格を動的に計算
     */
    async calculateDynamicPrice(gpuId, gpuModel, options = {}) {
        const {
            duration = 1, // 時間
            urgency = 'normal', // normal, urgent, scheduled
            quality = 100, // GPU品質スコア
            region = 'US',
            currentSupply = null,
            currentDemand = null,
            providerReputation = 100
        } = options;
        
        // 基本価格取得（MarketPricingEngineから）
        const marketPrice = this.marketPricing.calculateGPUPrice(gpuModel, { region });
        let dynamicPrice = marketPrice.price.hourly;
        
        // 供給需要分析
        const supplyDemandFactor = await this.analyzeSupplyDemand(gpuModel, currentSupply, currentDemand);
        dynamicPrice *= supplyDemandFactor;
        
        // 時間帯調整
        const timeFactor = this.calculateTimeFactor(new Date());
        dynamicPrice *= timeFactor;
        
        // 品質調整
        const qualityFactor = this.calculateQualityFactor(quality);
        dynamicPrice *= qualityFactor;
        
        // 評判調整
        const reputationFactor = this.calculateReputationFactor(providerReputation);
        dynamicPrice *= reputationFactor;
        
        // 緊急度調整
        const urgencyFactor = this.calculateUrgencyFactor(urgency);
        dynamicPrice *= urgencyFactor;
        
        // 期間割引（MarketPricingEngineの割引を使用）
        const durationDiscount = this.marketPricing.calculateDurationDiscount(duration);
        dynamicPrice *= durationDiscount;
        
        // ML予測による調整
        const mlAdjustment = await this.getMLPriceAdjustment(gpuModel, {
            basePrice: dynamicPrice,
            supply: currentSupply,
            demand: currentDemand,
            time: new Date(),
            region: region
        });
        dynamicPrice *= mlAdjustment;
        
        // 価格制限適用
        dynamicPrice = this.applyPriceLimits(dynamicPrice, marketPrice.price.hourly);
        
        // 結果作成
        const result = {
            gpuId: gpuId,
            gpuModel: gpuModel,
            pricing: {
                base: marketPrice.price.hourly,
                dynamic: dynamicPrice,
                usd: dynamicPrice,
                btc: dynamicPrice / (await this.getBTCPrice()) // BTC換算
            },
            factors: {
                supplyDemand: supplyDemandFactor,
                time: timeFactor,
                quality: qualityFactor,
                reputation: reputationFactor,
                urgency: urgencyFactor,
                duration: durationDiscount,
                ml: mlAdjustment
            },
            savings: {
                amount: marketPrice.price.hourly - dynamicPrice,
                percentage: ((marketPrice.price.hourly - dynamicPrice) / marketPrice.price.hourly) * 100
            },
            metadata: {
                timestamp: Date.now(),
                region: region,
                duration: duration,
                urgency: urgency
            }
        };
        
        // 履歴保存
        await this.savePriceHistory(gpuModel, result);
        
        // イベント発火
        this.emit('price-calculated', result);
        
        return result;
    }

    /**
     * 供給需要分析
     */
    async analyzeSupplyDemand(gpuModel, currentSupply = null, currentDemand = null) {
        // 現在の供給量取得
        const supply = currentSupply || await this.getCurrentSupply(gpuModel);
        const demand = currentDemand || await this.getCurrentDemand(gpuModel);
        
        // 供給需要比率
        const ratio = demand / (supply + 1); // +1で0除算防止
        
        // 価格弾力性モデル
        let factor = 1.0;
        
        if (ratio > 2.0) {
            // 需要過多：価格上昇
            factor = 1.0 + (ratio - 2.0) * 0.1; // 最大50%上昇
            factor = Math.min(factor, 1.5);
        } else if (ratio < 0.5) {
            // 供給過多：価格下降
            factor = 0.8 + ratio * 0.4; // 最大20%下降
        } else {
            // バランス状態：微調整
            factor = 0.9 + ratio * 0.1;
        }
        
        // 履歴更新
        this.marketData.supply.set(gpuModel, supply);
        this.marketData.demand.set(gpuModel, demand);
        
        logger.debug(`Supply/Demand for ${gpuModel}: ${supply}/${demand} = ${ratio.toFixed(2)}, factor: ${factor.toFixed(2)}`);
        
        return factor;
    }

    /**
     * 時間帯による価格調整
     */
    calculateTimeFactor(date) {
        const hour = date.getHours();
        const dayOfWeek = date.getDay();
        
        // 基本時間帯係数
        let timeFactor = 1.0;
        
        // 時間帯別調整
        if (hour >= 2 && hour <= 6) {
            // 深夜：需要低
            timeFactor = 0.85;
        } else if (hour >= 9 && hour <= 17) {
            // 業務時間：AI/ML需要高
            timeFactor = 1.15;
        } else if (hour >= 20 && hour <= 23) {
            // ゲームプライムタイム：供給低
            timeFactor = 1.25;
        }
        
        // 週末調整
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            timeFactor *= 0.95; // 週末は5%減
        }
        
        // 月末調整（企業の計算需要）
        const date_num = date.getDate();
        if (date_num >= 25) {
            timeFactor *= 1.1;
        }
        
        return timeFactor;
    }

    /**
     * 品質係数計算
     */
    calculateQualityFactor(qualityScore) {
        // 品質スコア（0-100）を係数に変換
        // 100: 1.1x, 80: 1.0x, 60: 0.9x
        return 0.7 + (qualityScore / 100) * 0.4;
    }

    /**
     * 評判係数計算
     */
    calculateReputationFactor(reputationScore) {
        // 評判スコア（0-100）を係数に変換
        // 高評価プロバイダーは価格プレミアム
        if (reputationScore >= 95) return 1.1;
        if (reputationScore >= 90) return 1.05;
        if (reputationScore >= 80) return 1.0;
        if (reputationScore >= 70) return 0.95;
        return 0.9;
    }

    /**
     * 緊急度係数
     */
    calculateUrgencyFactor(urgency) {
        const factors = {
            'scheduled': 0.9,  // 予約：割引
            'normal': 1.0,     // 通常
            'urgent': 1.2,     // 緊急：割増
            'critical': 1.5    // 最優先：大幅割増
        };
        
        return factors[urgency] || 1.0;
    }

    /**
     * ML価格調整
     */
    async getMLPriceAdjustment(gpuModel, features) {
        if (!this.pricingModel) {
            return 1.0;
        }
        
        try {
            // 特徴量準備
            const input = tf.tensor2d([[
                features.basePrice,
                features.supply || 0,
                features.demand || 0,
                features.time.getHours(),
                features.time.getDay(),
                this.encodeRegion(features.region)
            ]]);
            
            // 予測
            const prediction = this.pricingModel.predict(input);
            const adjustment = await prediction.data();
            
            input.dispose();
            prediction.dispose();
            
            // 調整係数を0.8-1.2の範囲に制限
            return Math.max(0.8, Math.min(1.2, adjustment[0]));
            
        } catch (error) {
            logger.error('ML prediction error:', error);
            return 1.0;
        }
    }

    /**
     * 価格制限適用
     */
    applyPriceLimits(price, basePrice) {
        const minPrice = basePrice * this.config.priceFloor;
        const maxPrice = basePrice * this.config.priceCeiling;
        
        return Math.max(minPrice, Math.min(maxPrice, price));
    }

    /**
     * 需要予測
     */
    async forecastDemand(gpuModel, hours = 24) {
        if (!this.demandForecastModel) {
            return null;
        }
        
        try {
            const historical = await this.getHistoricalDemand(gpuModel, 168); // 1週間
            
            if (historical.length < 24) {
                return null;
            }
            
            // 時系列予測
            const input = tf.tensor2d([historical.slice(-24)]);
            const prediction = this.demandForecastModel.predict(input);
            const forecast = await prediction.data();
            
            input.dispose();
            prediction.dispose();
            
            return Array.from(forecast).slice(0, hours);
            
        } catch (error) {
            logger.error('Demand forecast error:', error);
            return null;
        }
    }

    /**
     * 収益最適化
     */
    async optimizeRevenue(gpuModel, constraints = {}) {
        const {
            minPrice = null,
            maxPrice = null,
            targetUtilization = 0.8,
            timeHorizon = 24 // 時間
        } = constraints;
        
        // 需要予測
        const demandForecast = await this.forecastDemand(gpuModel, timeHorizon);
        
        if (!demandForecast) {
            return null;
        }
        
        // 価格弾力性推定
        const elasticity = await this.estimatePriceElasticity(gpuModel);
        
        // 最適価格計算
        const optimalPrices = [];
        
        for (let hour = 0; hour < timeHorizon; hour++) {
            const demand = demandForecast[hour];
            const supply = await this.getForecastSupply(gpuModel, hour);
            
            // 収益関数最大化
            let optimalPrice = this.calculateOptimalPrice(
                demand,
                supply,
                elasticity,
                targetUtilization
            );
            
            // 制約適用
            if (minPrice) optimalPrice = Math.max(minPrice, optimalPrice);
            if (maxPrice) optimalPrice = Math.min(maxPrice, optimalPrice);
            
            optimalPrices.push({
                hour: hour,
                price: optimalPrice,
                expectedDemand: demand,
                expectedRevenue: optimalPrice * demand * targetUtilization
            });
        }
        
        return {
            gpuModel: gpuModel,
            timeHorizon: timeHorizon,
            prices: optimalPrices,
            totalExpectedRevenue: optimalPrices.reduce((sum, p) => sum + p.expectedRevenue, 0),
            averagePrice: optimalPrices.reduce((sum, p) => sum + p.price, 0) / optimalPrices.length
        };
    }

    /**
     * 価格弾力性推定
     */
    async estimatePriceElasticity(gpuModel) {
        const history = await this.getPriceHistory(gpuModel, 30); // 30日
        
        if (history.length < 10) {
            return -1.0; // デフォルト弾力性
        }
        
        // 価格と需要の相関分析
        const prices = history.map(h => h.price);
        const demands = history.map(h => h.demand);
        
        // 対数変換
        const logPrices = prices.map(p => Math.log(p));
        const logDemands = demands.map(d => Math.log(d + 1));
        
        // 線形回帰で弾力性推定
        const elasticity = this.calculateElasticity(logPrices, logDemands);
        
        return elasticity;
    }

    /**
     * リアルタイム価格更新
     */
    async updatePricesRealtime() {
        try {
            // アクティブなGPU取得
            const activeGPUs = await this.db.getActiveGPUs();
            
            for (const gpu of activeGPUs) {
                // 現在の市場状況取得
                const marketConditions = await this.getCurrentMarketConditions(gpu.model);
                
                // 価格再計算が必要か判定
                if (this.needsPriceUpdate(gpu, marketConditions)) {
                    const newPrice = await this.calculateDynamicPrice(
                        gpu.id,
                        gpu.model,
                        marketConditions
                    );
                    
                    // 価格更新
                    await this.updateGPUPrice(gpu.id, newPrice);
                    
                    // 通知
                    this.emit('price-updated', {
                        gpuId: gpu.id,
                        oldPrice: gpu.currentPrice,
                        newPrice: newPrice,
                        reason: marketConditions.updateReason
                    });
                }
            }
            
        } catch (error) {
            logger.error('Realtime price update error:', error);
        }
    }

    /**
     * 価格更新判定
     */
    needsPriceUpdate(gpu, marketConditions) {
        // 前回更新からの経過時間
        const timeSinceUpdate = Date.now() - gpu.lastPriceUpdate;
        
        // 通常更新
        if (timeSinceUpdate > this.config.baseUpdateInterval) {
            marketConditions.updateReason = 'scheduled';
            return true;
        }
        
        // 市場変動による緊急更新
        const priceChange = Math.abs(marketConditions.suggestedPrice - gpu.currentPrice) / gpu.currentPrice;
        if (priceChange > this.config.volatilityThreshold) {
            marketConditions.updateReason = 'volatility';
            return true;
        }
        
        // 供給需要の急変
        if (marketConditions.demandSurge || marketConditions.supplyShortage) {
            marketConditions.updateReason = 'market_shift';
            return true;
        }
        
        return false;
    }

    /**
     * ML モデル初期化
     */
    async initializeMLModels() {
        try {
            // 価格調整モデル
            this.pricingModel = tf.sequential({
                layers: [
                    tf.layers.dense({ inputShape: [6], units: 64, activation: 'relu' }),
                    tf.layers.dropout({ rate: 0.2 }),
                    tf.layers.dense({ units: 32, activation: 'relu' }),
                    tf.layers.dense({ units: 1, activation: 'sigmoid' })
                ]
            });
            
            this.pricingModel.compile({
                optimizer: tf.train.adam(this.config.learningRate),
                loss: 'meanSquaredError'
            });
            
            // 需要予測モデル（LSTM）
            this.demandForecastModel = tf.sequential({
                layers: [
                    tf.layers.lstm({ inputShape: [24, 1], units: 50, returnSequences: true }),
                    tf.layers.dropout({ rate: 0.2 }),
                    tf.layers.lstm({ units: 50 }),
                    tf.layers.dense({ units: 24 })
                ]
            });
            
            this.demandForecastModel.compile({
                optimizer: tf.train.adam(this.config.learningRate),
                loss: 'meanSquaredError'
            });
            
            // 保存されたモデルの読み込み
            await this.loadSavedModels();
            
        } catch (error) {
            logger.error('Failed to initialize ML models:', error);
        }
    }

    /**
     * モデル学習
     */
    async trainModels() {
        // 定期的にモデルを再学習
        try {
            // 学習データ取得
            const trainingData = await this.getTrainingData();
            
            if (trainingData.length < 100) {
                return; // データ不足
            }
            
            // 価格調整モデル学習
            const priceFeatures = trainingData.map(d => [
                d.basePrice,
                d.supply,
                d.demand,
                d.hour,
                d.dayOfWeek,
                d.region
            ]);
            
            const priceLabels = trainingData.map(d => d.actualPriceAdjustment);
            
            await this.pricingModel.fit(
                tf.tensor2d(priceFeatures),
                tf.tensor1d(priceLabels),
                {
                    epochs: 50,
                    batchSize: 32,
                    validationSplit: 0.2
                }
            );
            
            logger.info('ML models trained successfully');
            
        } catch (error) {
            logger.error('Model training error:', error);
        }
    }

    /**
     * BTC価格取得
     */
    async getBTCPrice() {
        try {
            // キャッシュチェック
            if (this.btcPriceCache && Date.now() - this.btcPriceCache.timestamp < 60000) {
                return this.btcPriceCache.price;
            }
            
            // 実際の実装では外部APIを使用
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
            const data = await response.json();
            const price = data.bitcoin.usd;
            
            // キャッシュ更新
            this.btcPriceCache = {
                price: price,
                timestamp: Date.now()
            };
            
            return price;
            
        } catch (error) {
            logger.error('Failed to get BTC price:', error);
            return 60000; // フォールバック価格
        }
    }

    /**
     * ヘルパーメソッド
     */
    
    async getCurrentSupply(gpuModel) {
        // データベースから現在の供給量取得
        return await this.db.getGPUSupply(gpuModel);
    }
    
    async getCurrentDemand(gpuModel) {
        // データベースから現在の需要量取得
        return await this.db.getGPUDemand(gpuModel);
    }
    
    async getCurrentMarketConditions(gpuModel) {
        const supply = await this.getCurrentSupply(gpuModel);
        const demand = await this.getCurrentDemand(gpuModel);
        const marketPrice = this.marketPricing.calculateGPUPrice(gpuModel);
        
        return {
            supply,
            demand,
            suggestedPrice: marketPrice.price.hourly,
            demandSurge: demand > supply * 1.5,
            supplyShortage: supply < demand * 0.5
        };
    }
    
    async getForecastSupply(gpuModel, hoursAhead) {
        // 供給予測（簡易実装）
        const currentSupply = await this.getCurrentSupply(gpuModel);
        const hourOfDay = (new Date().getHours() + hoursAhead) % 24;
        
        // 時間帯による供給変動
        if (hourOfDay >= 2 && hourOfDay <= 6) {
            return currentSupply * 1.2; // 深夜は供給増
        } else if (hourOfDay >= 18 && hourOfDay <= 22) {
            return currentSupply * 0.7; // 夜は供給減
        }
        
        return currentSupply;
    }
    
    encodeRegion(region) {
        const regionMap = { 
            'US': 0, 'US-EAST': 0, 'US-WEST': 1,
            'EU': 2, 'EU-WEST': 2, 'EU-CENTRAL': 3,
            'ASIA': 4, 'ASIA-PACIFIC': 4, 'ASIA-SOUTH': 5,
            'LATAM': 6, 'AFRICA': 7
        };
        return regionMap[region] || 0;
    }
    
    calculateOptimalPrice(demand, supply, elasticity, targetUtil) {
        // 収益最大化価格計算（簡易版）
        const basePrice = this.marketPricing.calculateGPUPrice('Generic GPU').price.hourly;
        const utilizationRatio = Math.min(demand / supply, targetUtil);
        return basePrice * (1 + (1 - utilizationRatio) * Math.abs(elasticity));
    }
    
    calculateElasticity(logPrices, logDemands) {
        // 線形回帰による弾力性計算（簡易版）
        const n = logPrices.length;
        const sumX = logPrices.reduce((a, b) => a + b, 0);
        const sumY = logDemands.reduce((a, b) => a + b, 0);
        const sumXY = logPrices.reduce((sum, x, i) => sum + x * logDemands[i], 0);
        const sumX2 = logPrices.reduce((sum, x) => sum + x * x, 0);
        
        return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    }
    
    async savePriceHistory(gpuModel, priceData) {
        await this.db.savePriceHistory({
            gpu_model: gpuModel,
            price: priceData.pricing.dynamic,
            factors: priceData.factors,
            timestamp: priceData.metadata.timestamp
        });
    }
    
    async getPriceHistory(gpuModel, days) {
        return await this.db.getPriceHistory(gpuModel, null, days);
    }
    
    async getHistoricalDemand(gpuModel, hours) {
        // 過去の需要データ取得（実装略）
        const data = [];
        for (let i = 0; i < hours; i++) {
            data.push(Math.random() * 100 + 50); // モックデータ
        }
        return data;
    }
    
    async getTrainingData() {
        // ML学習用データ取得（実装略）
        return [];
    }
    
    async loadHistoricalData() {
        // 履歴データ読み込み（実装略）
        logger.info('Historical data loaded');
    }
    
    async loadSavedModels() {
        // 保存済みモデル読み込み（実装略）
        logger.info('Saved models loaded');
    }
    
    async updateGPUPrice(gpuId, priceData) {
        // GPU価格更新（実装略）
        await this.db.updateGPUPrice(gpuId, priceData.pricing.dynamic);
    }
    
    startPeriodicUpdates() {
        // 定期価格更新
        setInterval(() => {
            this.updatePricesRealtime();
        }, this.config.baseUpdateInterval);
        
        // モデル再学習（1日1回）
        setInterval(() => {
            this.trainModels();
        }, 24 * 60 * 60 * 1000);
    }
}

module.exports = { DynamicPricingEngine };