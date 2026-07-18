// Exercises src/core/logger.js — the winston-based logger used by
// src/reputation/provider-uptime.js. Its many helper methods (event loggers
// that append to dedicated files, the HTTP middleware, reportError, searchLogs,
// getStats) were entirely untested. Everything is driven against a throwaway
// LOG_DIR so no real logs/ output is touched.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Must be set before requiring the module: logDir is captured at load time.
const TMP_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'strawberry-logtest-'));
process.env.LOG_DIR = TMP_LOG_DIR;

const { logger } = require('../../src/core/logger');

// appendFile is fire-and-forget (callback style); poll briefly for the write.
async function waitForFile(file, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

afterAll(() => {
  try { fs.rmSync(TMP_LOG_DIR, { recursive: true, force: true }); } catch (_) {}
});

describe('core/logger event loggers', () => {
  it('gpuEvent appends a JSON line to gpu-events.log', async () => {
    logger.gpuEvent('gpu_allocated', { gpuId: 'g1', rentalId: 'r1' });
    const content = await waitForFile(path.join(TMP_LOG_DIR, 'gpu-events.log'));
    const entry = JSON.parse(content.trim().split('\n').pop());
    expect(entry.event).toBe('gpu_allocated');
    expect(entry.data.gpuId).toBe('g1');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('paymentEvent masks paymentRequest/paymentPreimage', async () => {
    logger.paymentEvent('invoice_paid', {
      amount: 1000,
      paymentRequest: 'lnbc1000n1p'.padEnd(40, 'x'),
      paymentPreimage: 'abcdef0123456789'.padEnd(30, 'y'),
    });
    const content = await waitForFile(path.join(TMP_LOG_DIR, 'payment-events.log'));
    const entry = JSON.parse(content.trim().split('\n').pop());
    expect(entry.event).toBe('invoice_paid');
    // masked forms: 20-char prefix + "...", 10-char prefix + "..."
    expect(entry.data.paymentRequest.endsWith('...')).toBe(true);
    expect(entry.data.paymentRequest.length).toBe(23);
    expect(entry.data.paymentPreimage.endsWith('...')).toBe(true);
    expect(entry.data.paymentPreimage.length).toBe(13);
    expect(entry.data.amount).toBe(1000);
  });

  it('securityEvent records severity and routes level', async () => {
    logger.securityEvent('login_bruteforce', { severity: 'critical', ip: '10.0.0.1' });
    logger.securityEvent('suspicious', { severity: 'high' });
    logger.securityEvent('note', {}); // default severity 'info'
    const content = await waitForFile(path.join(TMP_LOG_DIR, 'security-events.log'));
    const lines = content.trim().split('\n').map((l) => JSON.parse(l));
    const crit = lines.find((l) => l.event === 'login_bruteforce');
    expect(crit.severity).toBe('critical');
    expect(lines.find((l) => l.event === 'note').severity).toBe('info');
  });

  it('performanceMetric appends metric entries', async () => {
    logger.performanceMetric('order_latency_ms', 42, { route: '/orders' });
    const content = await waitForFile(path.join(TMP_LOG_DIR, 'performance-metrics.log'));
    const entry = JSON.parse(content.trim().split('\n').pop());
    expect(entry.metric).toBe('order_latency_ms');
    expect(entry.value).toBe(42);
    expect(entry.route).toBe('/orders');
  });
});

describe('core/logger httpMiddleware', () => {
  function runMiddleware(statusCode) {
    const req = { method: 'GET', originalUrl: '/x', ip: '127.0.0.1', get: () => 'jest', connection: {} };
    const res = new EventEmitter();
    res.statusCode = statusCode;
    let nextCalled = false;
    logger.httpMiddleware(req, res, () => { nextCalled = true; });
    res.emit('finish');
    return nextCalled;
  }
  it('calls next and handles 2xx/4xx/5xx status branches without throwing', () => {
    expect(runMiddleware(200)).toBe(true);
    expect(runMiddleware(404)).toBe(true);
    expect(runMiddleware(500)).toBe(true);
  });
});

describe('core/logger utility methods', () => {
  it('setLevel updates the logger level', () => {
    logger.setLevel('debug');
    expect(logger.level).toBe('debug');
    logger.setLevel('info');
    expect(logger.level).toBe('info');
  });

  it('reportError writes a JSON error report file', async () => {
    await logger.reportError(new Error('boom'), { where: 'unit-test' });
    const reportDir = path.join(TMP_LOG_DIR, 'error-reports');
    const files = fs.readdirSync(reportDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'));
    expect(report.error.message).toBe('boom');
    expect(report.context.where).toBe('unit-test');
    expect(typeof report.context.nodeVersion).toBe('string');
  });

  it('searchLogs returns matching entries filtered by keyword and level', async () => {
    // Seed a parseable JSON log file in the log dir.
    const seed = [
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', message: 'alpha marker' }),
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', message: 'beta' }),
      'not-json-should-be-skipped',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(TMP_LOG_DIR, 'strawberry-seed.log'), seed);

    const byKeyword = await logger.searchLogs({ keyword: 'alpha marker' });
    expect(byKeyword.some((l) => l.message === 'alpha marker')).toBe(true);

    const byLevel = await logger.searchLogs({ level: 'warn' });
    expect(byLevel.every((l) => l.level === 'warn')).toBe(true);
  });

  it('getStats aggregates file sizes and formats total size', async () => {
    const stats = await logger.getStats();
    expect(stats).not.toBeNull();
    expect(stats.totalFiles).toBeGreaterThan(0);
    expect(typeof stats.totalSizeFormatted).toBe('string');
    // formatBytes output like "12.34 KB" / "0 Bytes"
    expect(stats.totalSizeFormatted).toMatch(/\d|\bBytes\b/);
  });
});
