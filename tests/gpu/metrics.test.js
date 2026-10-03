// tests/gpu/metrics.test.js — MetricsCollector の収集・集計契約を固定
// - record* 系が prom-client の gauge/counter/histogram に値を載せること
// - calculateHistogramAverage が _sum/_count エントリから正しく平均を返すこと
//   （先頭エントリは _bucket なので [0] を読む実装だと常に 0 になる回帰防止）
// - addToHistory が maxHistorySize を超えないこと
// - startCollection がタイマーを追跡・unref・再初期化で置き換えること
const { MetricsCollector } = require('../../src/gpu/metrics');

describe('MetricsCollector', () => {
  let collector;
  beforeEach(() => {
    collector = new MetricsCollector();
  });
  afterEach(() => {
    collector.cleanup();
  });

  it('recordGPUMetrics sets gauges and appends a history entry', () => {
    collector.recordGPUMetrics({
      gpu_id: 'g1', model: 'RTX 4090',
      utilization: 80, temperature: 65, memory_used: 16 * 1024 ** 3, power_draw: 400,
    });
    expect(collector.getGaugeValue('strawberry_gpu_utilization_percent', { gpu_model: 'RTX 4090' })).toBe(80);
    expect(collector.getGaugeValue('strawberry_gpu_temperature_celsius', { gpu_model: 'RTX 4090' })).toBe(65);
    const gpuHistory = collector.historyBuffer.filter(h => h.type === 'gpu');
    expect(gpuHistory).toHaveLength(1);
    expect(gpuHistory[0].data.gpu_id).toBe('g1');
  });

  it('recordGPUMetrics swallows malformed input without throwing', () => {
    expect(() => collector.recordGPUMetrics(undefined)).not.toThrow();
    expect(collector.historyBuffer.filter(h => h.type === 'gpu')).toHaveLength(0);
  });

  it('recordRentalMetrics accumulates revenue counter', () => {
    collector.recordRentalMetrics({ gpu_model: 'RTX 4090', region: 'jp', price_per_hour: 2, duration_hours: 3, revenue: 6, payment_method: 'ln' });
    collector.recordRentalMetrics({ gpu_model: 'RTX 4090', region: 'jp', price_per_hour: 2, duration_hours: 1, revenue: 2, payment_method: 'ln' });
    expect(collector.getCounterValue('strawberry_rental_revenue_usd_total')).toBe(8);
  });

  it('calculateHistogramAverage reads the _sum/_count samples (bucket entries skipped)', () => {
    collector.recordNetworkMetrics({ peer_count: 5, latency_ms: 100, region: 'jp', bandwidth_in: 1, bandwidth_out: 1 });
    collector.recordNetworkMetrics({ peer_count: 5, latency_ms: 200, region: 'jp', bandwidth_in: 1, bandwidth_out: 1 });
    // 回帰検証: 先頭 _bucket エントリを読む旧実装では count=0 → 常に 0 だった
    expect(collector.calculateHistogramAverage('strawberry_p2p_latency_ms')).toBe(150);
  });

  it('getMetricsSummary reflects observed latency as avgLatency', () => {
    collector.recordNetworkMetrics({ peer_count: 3, latency_ms: 40, region: 'us', bandwidth_in: 0, bandwidth_out: 0 });
    collector.recordNetworkMetrics({ peer_count: 3, latency_ms: 80, region: 'us', bandwidth_in: 0, bandwidth_out: 0 });
    const summary = collector.getMetricsSummary();
    expect(summary.network.avgLatency).toBe(60);
    expect(summary.network.connectedPeers).toBe(3);
  });

  it('recordNetworkMetrics skips latency when absent', () => {
    collector.recordNetworkMetrics({ peer_count: 2, region: 'jp', bandwidth_in: 0, bandwidth_out: 0 });
    expect(collector.calculateHistogramAverage('strawberry_p2p_latency_ms')).toBe(0);
  });

  it('addToHistory caps the buffer at maxHistorySize', () => {
    collector.maxHistorySize = 5;
    for (let i = 0; i < 8; i++) collector.addToHistory('test', { i });
    expect(collector.historyBuffer).toHaveLength(5);
    expect(collector.historyBuffer[0].data.i).toBe(3); // 先頭3件が切り捨て
    expect(collector.historyBuffer[4].data.i).toBe(7);
  });

  it('startCollection tracks + unrefs the timer; restart replaces it', () => {
    collector.startCollection(60000);
    const first = collector.collectionInterval;
    expect(first).toBeTruthy();
    expect(typeof first.hasRef === 'function' ? first.hasRef() : true).toBe(false); // unref 済み
    collector.startCollection(30000);
    expect(collector.collectionInterval).not.toBe(first); // 再初期化で置き換え（多重化しない）
    collector.stopCollection();
    expect(collector.collectionInterval).toBeNull();
  });

  it('exportMetrics emits Prometheus text with the metric names', async () => {
    const text = await collector.exportMetrics();
    expect(text).toContain('strawberry_gpus_total');
    expect(text).toContain('strawberry_p2p_latency_ms');
  });

  it('cleanup stops collection and clears history', () => {
    collector.startCollection(60000);
    collector.addToHistory('x', {});
    collector.cleanup();
    expect(collector.collectionInterval).toBeNull();
    expect(collector.historyBuffer).toHaveLength(0);
  });
});
