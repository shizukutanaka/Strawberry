// src/monitoring/metrics.js - Metrics Collection Module
const promClient = require('prom-client');
const { logger } = require('../utils/logger');
const os = require('os');
const v8 = require('v8');

class MetricsCollector {
    constructor() {
        // Prometheusレジストリ
        this.register = new promClient.Registry();
        
        // デフォルトメトリクス
        promClient.collectDefaultMetrics({ register: this.register });
        
        // カスタムメトリクス定義
        this.setupCustomMetrics();
        
        // 収集インターバル
        this.collectionInterval = null;
        this.historyBuffer = [];
        this.maxHistorySize = 1000;
    }

    setupCustomMetrics() {
        // GPU関連メトリクス
        this.gpuMetrics = {
            // ゲージ: 現在の値
            totalGPUs: new promClient.Gauge({
                name: 'strawberry_gpus_total',
                help: 'Total number of GPUs in the system',
                labelNames: ['status', 'model']
            }),
            
            gpuUtilization: new promClient.Gauge({
                name: 'strawberry_gpu_utilization_percent',
                help: 'GPU utilization percentage',
                labelNames: ['gpu_id', 'gpu_model']
            }),
            
            gpuTemperature: new promClient.Gauge({
                name: 'strawberry_gpu_temperature_celsius',
                help: 'GPU temperature in Celsius',
                labelNames: ['gpu_id', 'gpu_model']
            }),
            
            gpuMemoryUsed: new promClient.Gauge({
                name: 'strawberry_gpu_memory_used_bytes',
                help: 'GPU memory used in bytes',
                labelNames: ['gpu_id', 'gpu_model']
            }),
            
            gpuPowerDraw: new promClient.Gauge({
                name: 'strawberry_gpu_power_draw_watts',
                help: 'GPU power draw in watts',
                labelNames: ['gpu_id', 'gpu_model']
            }),
            
            // ヒストグラム: 分布
            gpuAllocationDuration: new promClient.Histogram({
                name: 'strawberry_gpu_allocation_duration_seconds',
                help: 'Duration of GPU allocations',
                labelNames: ['gpu_model'],
                buckets: [60, 300, 600, 1800, 3600, 7200, 14400] // 1分〜4時間
            })
        };

        // レンタル関連メトリクス
        this.rentalMetrics = {
            activeRentals: new promClient.Gauge({
                name: 'strawberry_active_rentals_total',
                help: 'Total number of active rentals',
                labelNames: ['gpu_model', 'region']
            }),
            
            rentalRevenue: new promClient.Counter({
                name: 'strawberry_rental_revenue_usd_total',
                help: 'Total rental revenue in USD',
                labelNames: ['gpu_model', 'payment_method']
            }),
            
            rentalDuration: new promClient.Histogram({
                name: 'strawberry_rental_duration_hours',
                help: 'Distribution of rental durations',
                labelNames: ['gpu_model'],
                buckets: [0.5, 1, 2, 4, 8, 12, 24, 48, 168] // 30分〜1週間
            }),
            
            rentalPrice: new promClient.Histogram({
                name: 'strawberry_rental_price_usd_per_hour',
                help: 'Distribution of rental prices per hour',
                labelNames: ['gpu_model'],
                buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20]
            })
        };

        // P2Pネットワークメトリクス
        this.networkMetrics = {
            connectedPeers: new promClient.Gauge({
                name: 'strawberry_p2p_connected_peers',
                help: 'Number of connected P2P peers',
                labelNames: ['peer_type']
            }),
            
            networkLatency: new promClient.Histogram({
                name: 'strawberry_p2p_latency_ms',
                help: 'P2P network latency in milliseconds',
                labelNames: ['region'],
                buckets: [10, 25, 50, 100, 250, 500, 1000]
            }),
            
            messagesSent: new promClient.Counter({
                name: 'strawberry_p2p_messages_sent_total',
                help: 'Total P2P messages sent',
                labelNames: ['message_type']
            }),
            
            messagesReceived: new promClient.Counter({
                name: 'strawberry_p2p_messages_received_total',
                help: 'Total P2P messages received',
                labelNames: ['message_type']
            }),
            
            bandwidth: new promClient.Gauge({
                name: 'strawberry_p2p_bandwidth_bytes_per_second',
                help: 'P2P network bandwidth usage',
                labelNames: ['direction'] // 'in' or 'out'
            })
        };

        // Lightning Network メトリクス
        this.lightningMetrics = {
            channelBalance: new promClient.Gauge({
                name: 'strawberry_lightning_channel_balance_sats',
                help: 'Lightning channel balance in satoshis',
                labelNames: ['channel_id', 'balance_type'] // 'local' or 'remote'
            }),
            
            paymentVolume: new promClient.Counter({
                name: 'strawberry_lightning_payment_volume_sats',
                help: 'Total Lightning payment volume',
                labelNames: ['payment_type'] // 'sent' or 'received'
            }),
            
            paymentCount: new promClient.Counter({
                name: 'strawberry_lightning_payment_count',
                help: 'Total number of Lightning payments',
                labelNames: ['payment_type', 'status'] // 'success' or 'failed'
            }),
            
            invoiceSettleTime: new promClient.Histogram({
                name: 'strawberry_lightning_invoice_settle_time_seconds',
                help: 'Time to settle Lightning invoices',
                buckets: [1, 5, 10, 30, 60, 300]
            }),
            
            routingFees: new promClient.Counter({
                name: 'strawberry_lightning_routing_fees_sats',
                help: 'Total routing fees collected',
                labelNames: ['channel_id']
            })
        };

        // システムメトリクス
        this.systemMetrics = {
            cpuUsage: new promClient.Gauge({
                name: 'strawberry_system_cpu_usage_percent',
                help: 'System CPU usage percentage',
                labelNames: ['cpu_core']
            }),
            
            memoryUsage: new promClient.Gauge({
                name: 'strawberry_system_memory_usage_bytes',
                help: 'System memory usage',
                labelNames: ['memory_type'] // 'used', 'free', 'total'
            }),
            
            diskUsage: new promClient.Gauge({
                name: 'strawberry_system_disk_usage_bytes',
                help: 'System disk usage',
                labelNames: ['disk_type', 'mount_point'] // 'used', 'free', 'total'
            }),
            
            processMetrics: new promClient.Gauge({
                name: 'strawberry_process_metrics',
                help: 'Node.js process metrics',
                labelNames: ['metric_type'] // 'heap_used', 'external', 'handles', etc.
            }),
            
            errorRate: new promClient.Counter({
                name: 'strawberry_errors_total',
                help: 'Total number of errors',
                labelNames: ['error_type', 'severity']
            })
        };

        // ビジネスメトリクス
        this.businessMetrics = {
            platformRevenue: new promClient.Counter({
                name: 'strawberry_platform_revenue_usd',
                help: 'Total platform revenue in USD',
                labelNames: ['revenue_type'] // 'fees', 'subscriptions', etc.
            }),
            
            userActivity: new promClient.Counter({
                name: 'strawberry_user_activity_total',
                help: 'User activity metrics',
                labelNames: ['activity_type'] // 'login', 'rental_start', 'gpu_listed', etc.
            }),
            
            conversionRate: new promClient.Gauge({
                name: 'strawberry_conversion_rate_percent',
                help: 'Conversion rate percentage',
                labelNames: ['conversion_type'] // 'visitor_to_user', 'user_to_renter', etc.
            }),
            
            marketDemand: new promClient.Gauge({
                name: 'strawberry_market_demand_score',
                help: 'Market demand score by GPU model',
                labelNames: ['gpu_model', 'region']
            })
        };

        // すべてのメトリクスをレジストリに登録
        this.registerAllMetrics();
    }

    registerAllMetrics() {
        const allMetrics = [
            ...Object.values(this.gpuMetrics),
            ...Object.values(this.rentalMetrics),
            ...Object.values(this.networkMetrics),
            ...Object.values(this.lightningMetrics),
            ...Object.values(this.systemMetrics),
            ...Object.values(this.businessMetrics)
        ];

        allMetrics.forEach(metric => {
            this.register.registerMetric(metric);
        });
    }

    // メトリクス収集開始
    startCollection(interval = 30000) {
        if (this.collectionInterval) {
            clearInterval(this.collectionInterval);
        }

        this.collectionInterval = setInterval(() => {
            this.collectSystemMetrics();
            this.collectProcessMetrics();
        }, interval);

        logger.info(`Metrics collection started with ${interval}ms interval`);
    }

    // メトリクス収集停止
    stopCollection() {
        if (this.collectionInterval) {
            clearInterval(this.collectionInterval);
            this.collectionInterval = null;
            logger.info('Metrics collection stopped');
        }
    }

    // システムメトリクス収集
    collectSystemMetrics() {
        try {
            // CPU使用率
            const cpus = os.cpus();
            cpus.forEach((cpu, index) => {
                const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
                const usage = 100 - Math.round(100 * cpu.times.idle / total);
                this.systemMetrics.cpuUsage.set({ cpu_core: `core_${index}` }, usage);
            });

            // メモリ使用率
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            this.systemMetrics.memoryUsage.set({ memory_type: 'total' }, totalMem);
            this.systemMetrics.memoryUsage.set({ memory_type: 'free' }, freeMem);
            this.systemMetrics.memoryUsage.set({ memory_type: 'used' }, usedMem);

            // プロセスメトリクス
            const memUsage = process.memoryUsage();
            this.systemMetrics.processMetrics.set({ metric_type: 'heap_used' }, memUsage.heapUsed);
            this.systemMetrics.processMetrics.set({ metric_type: 'heap_total' }, memUsage.heapTotal);
            this.systemMetrics.processMetrics.set({ metric_type: 'external' }, memUsage.external);
            this.systemMetrics.processMetrics.set({ metric_type: 'rss' }, memUsage.rss);

        } catch (error) {
            logger.error('Failed to collect system metrics:', error);
        }
    }

    // プロセスメトリクス収集
    collectProcessMetrics() {
        try {
            // V8ヒープ統計
            const heapStats = v8.getHeapStatistics();
            this.systemMetrics.processMetrics.set(
                { metric_type: 'heap_size_limit' },
                heapStats.heap_size_limit
            );
            this.systemMetrics.processMetrics.set(
                { metric_type: 'total_heap_size' },
                heapStats.total_heap_size
            );
            this.systemMetrics.processMetrics.set(
                { metric_type: 'used_heap_size' },
                heapStats.used_heap_size
            );

            // イベントループ遅延
            const start = process.hrtime.bigint();
            setImmediate(() => {
                const delay = Number(process.hrtime.bigint() - start) / 1e6; // ミリ秒に変換
                this.systemMetrics.processMetrics.set(
                    { metric_type: 'event_loop_delay_ms' },
                    delay
                );
            });

        } catch (error) {
            logger.error('Failed to collect process metrics:', error);
        }
    }

    // GPU メトリクス記録
    recordGPUMetrics(gpuData) {
        try {
            const { gpu_id, model, utilization, temperature, memory_used, power_draw } = gpuData;

            this.gpuMetrics.gpuUtilization.set(
                { gpu_id, gpu_model: model },
                utilization
            );

            this.gpuMetrics.gpuTemperature.set(
                { gpu_id, gpu_model: model },
                temperature
            );

            this.gpuMetrics.gpuMemoryUsed.set(
                { gpu_id, gpu_model: model },
                memory_used
            );

            this.gpuMetrics.gpuPowerDraw.set(
                { gpu_id, gpu_model: model },
                power_draw
            );

            // 履歴バッファに追加
            this.addToHistory('gpu', {
                timestamp: Date.now(),
                gpu_id,
                model,
                utilization,
                temperature,
                memory_used,
                power_draw
            });

        } catch (error) {
            logger.error('Failed to record GPU metrics:', error);
        }
    }

    // レンタルメトリクス記録
    recordRentalMetrics(rentalData) {
        try {
            const { gpu_model, region, price_per_hour, duration_hours, revenue, payment_method } = rentalData;

            this.rentalMetrics.rentalRevenue.inc(
                { gpu_model, payment_method },
                revenue
            );

            this.rentalMetrics.rentalDuration.observe(
                { gpu_model },
                duration_hours
            );

            this.rentalMetrics.rentalPrice.observe(
                { gpu_model },
                price_per_hour
            );

            // アクティブレンタル数更新
            this.updateActiveRentals();

        } catch (error) {
            logger.error('Failed to record rental metrics:', error);
        }
    }

    // P2Pネットワークメトリクス記録
    recordNetworkMetrics(networkData) {
        try {
            const { peer_count, latency_ms, region, bandwidth_in, bandwidth_out } = networkData;

            this.networkMetrics.connectedPeers.set(
                { peer_type: 'gpu_provider' },
                peer_count
            );

            if (latency_ms !== undefined) {
                this.networkMetrics.networkLatency.observe(
                    { region },
                    latency_ms
                );
            }

            this.networkMetrics.bandwidth.set(
                { direction: 'in' },
                bandwidth_in
            );

            this.networkMetrics.bandwidth.set(
                { direction: 'out' },
                bandwidth_out
            );

        } catch (error) {
            logger.error('Failed to record network metrics:', error);
        }
    }

    // Lightning メトリクス記録
    recordLightningMetrics(lightningData) {
        try {
            const {
                channel_id,
                local_balance,
                remote_balance,
                payment_amount,
                payment_type,
                payment_status,
                settle_time
            } = lightningData;

            if (local_balance !== undefined) {
                this.lightningMetrics.channelBalance.set(
                    { channel_id, balance_type: 'local' },
                    local_balance
                );
            }

            if (remote_balance !== undefined) {
                this.lightningMetrics.channelBalance.set(
                    { channel_id, balance_type: 'remote' },
                    remote_balance
                );
            }

            if (payment_amount !== undefined) {
                this.lightningMetrics.paymentVolume.inc(
                    { payment_type },
                    payment_amount
                );

                this.lightningMetrics.paymentCount.inc(
                    { payment_type, status: payment_status }
                );
            }

            if (settle_time !== undefined) {
                this.lightningMetrics.invoiceSettleTime.observe(settle_time);
            }

        } catch (error) {
            logger.error('Failed to record Lightning metrics:', error);
        }
    }

    // エラーメトリクス記録
    recordError(errorType, severity = 'error') {
        this.systemMetrics.errorRate.inc({ error_type: errorType, severity });
    }

    // ビジネスメトリクス記録
    recordBusinessMetrics(businessData) {
        try {
            const { revenue_type, amount, activity_type, conversion_type, conversion_rate } = businessData;

            if (amount !== undefined) {
                this.businessMetrics.platformRevenue.inc(
                    { revenue_type },
                    amount
                );
            }

            if (activity_type) {
                this.businessMetrics.userActivity.inc({ activity_type });
            }

            if (conversion_rate !== undefined) {
                this.businessMetrics.conversionRate.set(
                    { conversion_type },
                    conversion_rate
                );
            }

        } catch (error) {
            logger.error('Failed to record business metrics:', error);
        }
    }

    // システム統計記録
    recordSystemStats(stats) {
        try {
            // GPU統計
            if (stats.localGPUs) {
                this.gpuMetrics.totalGPUs.set(
                    { status: 'available', model: 'all' },
                    stats.localGPUs.available
                );
                this.gpuMetrics.totalGPUs.set(
                    { status: 'lending', model: 'all' },
                    stats.localGPUs.lending
                );
            }

            // アクティブレンタル
            if (stats.activeRentals) {
                this.rentalMetrics.activeRentals.set(
                    { gpu_model: 'all', region: 'all' },
                    stats.activeRentals.total
                );
            }

            // その他の統計をメトリクスに変換
            this.addToHistory('system_stats', {
                timestamp: Date.now(),
                ...stats
            });

        } catch (error) {
            logger.error('Failed to record system stats:', error);
        }
    }

    // 履歴バッファ管理
    addToHistory(type, data) {
        this.historyBuffer.push({
            type,
            data,
            timestamp: Date.now()
        });

        // バッファサイズ制限
        if (this.historyBuffer.length > this.maxHistorySize) {
            this.historyBuffer = this.historyBuffer.slice(-this.maxHistorySize);
        }
    }

    // メトリクスエクスポート（Prometheus形式）
    async exportMetrics() {
        try {
            return await this.register.metrics();
        } catch (error) {
            logger.error('Failed to export metrics:', error);
            return '';
        }
    }

    // メトリクスサマリー取得
    getMetricsSummary() {
        const summary = {
            timestamp: Date.now(),
            gpu: {
                total: this.register.getSingleMetric('strawberry_gpus_total')?.get() || {},
                avgUtilization: this.calculateAverage('strawberry_gpu_utilization_percent'),
                avgTemperature: this.calculateAverage('strawberry_gpu_temperature_celsius')
            },
            rental: {
                active: this.register.getSingleMetric('strawberry_active_rentals_total')?.get() || {},
                totalRevenue: this.getCounterValue('strawberry_rental_revenue_usd_total')
            },
            network: {
                connectedPeers: this.getGaugeValue('strawberry_p2p_connected_peers'),
                avgLatency: this.calculateHistogramAverage('strawberry_p2p_latency_ms')
            },
            system: {
                cpuUsage: this.calculateAverage('strawberry_system_cpu_usage_percent'),
                memoryUsage: this.getGaugeValue('strawberry_system_memory_usage_bytes', { memory_type: 'used' }),
                errors: this.getCounterValue('strawberry_errors_total')
            }
        };

        return summary;
    }

    // ヘルパーメソッド
    calculateAverage(metricName) {
        const metric = this.register.getSingleMetric(metricName);
        if (!metric) return 0;

        const values = metric.get();
        if (values.values) {
            const sum = values.values.reduce((acc, v) => acc + v.value, 0);
            return values.values.length > 0 ? sum / values.values.length : 0;
        }
        return 0;
    }

    getGaugeValue(metricName, labels = {}) {
        const metric = this.register.getSingleMetric(metricName);
        if (!metric) return 0;

        const values = metric.get();
        if (values.values) {
            const value = values.values.find(v => {
                return Object.entries(labels).every(([key, val]) => v.labels[key] === val);
            });
            return value ? value.value : 0;
        }
        return 0;
    }

    getCounterValue(metricName) {
        const metric = this.register.getSingleMetric(metricName);
        if (!metric) return 0;

        const values = metric.get();
        if (values.values) {
            return values.values.reduce((acc, v) => acc + v.value, 0);
        }
        return 0;
    }

    calculateHistogramAverage(metricName) {
        const metric = this.register.getSingleMetric(metricName);
        if (!metric) return 0;

        const values = metric.get();
        if (values.values && values.values.length > 0) {
            const sum = values.values[0].metricName.includes('sum') ? values.values[0].value : 0;
            const count = values.values[0].metricName.includes('count') ? values.values[0].value : 0;
            return count > 0 ? sum / count : 0;
        }
        return 0;
    }

    updateActiveRentals() {
        // アクティブレンタル数を更新するロジック
        // 実際の実装では、データベースやキャッシュから取得
    }

    // カスタムメトリクス登録
    registerCustomMetric(name, help, type = 'gauge', labelNames = []) {
        let metric;
        
        switch (type) {
            case 'counter':
                metric = new promClient.Counter({ name, help, labelNames });
                break;
            case 'histogram':
                metric = new promClient.Histogram({ name, help, labelNames });
                break;
            case 'summary':
                metric = new promClient.Summary({ name, help, labelNames });
                break;
            default:
                metric = new promClient.Gauge({ name, help, labelNames });
        }

        this.register.registerMetric(metric);
        return metric;
    }

    // メトリクスリセット
    resetMetrics() {
        this.register.resetMetrics();
        logger.info('All metrics have been reset');
    }

    // クリーンアップ
    cleanup() {
        this.stopCollection();
        this.historyBuffer = [];
        logger.info('Metrics collector cleaned up');
    }
}

module.exports = { MetricsCollector };