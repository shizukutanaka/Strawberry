// tests/security/probe59-process-guards.test.js
// Probe 59 (production robustness): the running server had no process-level last-resort
// handlers. registerProcessGuards installs uncaughtException/unhandledRejection handlers
// that log with context (so failures are diagnosable, not silent crashes) and, on an
// uncaught exception, close the server and exit non-zero (state is undefined after an
// uncaughtException — Node guidance says do not resume).

const { EventEmitter } = require('events');
const { registerProcessGuards } = require('../../src/utils/process-guards');

function makeLogger() {
  const calls = [];
  return { calls, error: (msg, meta) => calls.push({ msg, meta }) };
}

describe('registerProcessGuards', () => {
  it('logs unhandled rejections with context and does NOT exit', () => {
    const proc = new EventEmitter();
    const logger = makeLogger();
    let exited = null;
    registerProcessGuards({ logger, proc, exit: (c) => { exited = c; } });

    proc.emit('unhandledRejection', new Error('boom-reject'));
    expect(logger.calls.some(c => /Unhandled promise rejection/.test(c.msg))).toBe(true);
    expect(logger.calls.some(c => /boom-reject/.test(c.meta.reason))).toBe(true);
    expect(exited).toBeNull(); // a single rejection must not take down the API
  });

  it('handles non-Error rejection reasons safely', () => {
    const proc = new EventEmitter();
    const logger = makeLogger();
    registerProcessGuards({ logger, proc, exit: () => {} });
    expect(() => proc.emit('unhandledRejection', 'plain string reason')).not.toThrow();
    expect(logger.calls.some(c => /plain string reason/.test(c.meta.reason))).toBe(true);
  });

  it('on uncaughtException: logs, closes the server, and exits(1)', (done) => {
    const proc = new EventEmitter();
    const logger = makeLogger();
    let closed = false;
    const fakeServer = { close: (cb) => { closed = true; cb(); } };
    registerProcessGuards({
      logger, proc, getServer: () => fakeServer,
      exit: (code) => {
        expect(code).toBe(1);
        expect(closed).toBe(true);
        expect(logger.calls.some(c => /Uncaught exception/.test(c.msg))).toBe(true);
        done();
      },
    });
    proc.emit('uncaughtException', new Error('fatal-xyz'));
  });

  it('on uncaughtException with no server: still exits(1)', (done) => {
    const proc = new EventEmitter();
    const logger = makeLogger();
    registerProcessGuards({
      logger, proc, getServer: () => null,
      exit: (code) => { expect(code).toBe(1); done(); },
    });
    proc.emit('uncaughtException', new Error('no-server'));
  });

  it('force-exits(1) if server.close hangs', (done) => {
    const proc = new EventEmitter();
    const logger = makeLogger();
    const hangingServer = { close: () => { /* never calls back */ } };
    registerProcessGuards({
      logger, proc, getServer: () => hangingServer, forceExitMs: 20,
      exit: (code) => { expect(code).toBe(1); done(); },
    });
    proc.emit('uncaughtException', new Error('hang'));
  });
});

describe('server.js wiring (source)', () => {
  it('registers process guards only inside the require.main === module block', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/server.js'), 'utf-8'
    );
    const mainIdx = src.indexOf('if (require.main === module)');
    const guardIdx = src.indexOf('registerProcessGuards({');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(mainIdx); // wired after the main guard opens
  });
});
