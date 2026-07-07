// tests/security/probe56-request-context-als.test.js
// Probe 56 (Qiita/Zenn request-id propagation review — completes I-11 / D-2):
// AsyncLocalStorage propagates requestId across the async call chain so every
// logger.* call within a request is automatically correlated, without threading the
// id through every function signature.

const winston = require('winston');
const { runWithContext, getRequestId } = require('../../src/utils/request-context');
const { stampRequestId } = require('../../src/utils/logger');

describe('request-context (AsyncLocalStorage)', () => {
  it('getRequestId returns the id set by runWithContext', () => {
    runWithContext({ requestId: 'rid-123' }, () => {
      expect(getRequestId()).toBe('rid-123');
    });
  });

  it('getRequestId is undefined outside any context', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('context survives across an await boundary', async () => {
    await runWithContext({ requestId: 'rid-async' }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      expect(getRequestId()).toBe('rid-async');
    });
  });

  it('nested contexts shadow correctly and restore', () => {
    runWithContext({ requestId: 'outer' }, () => {
      expect(getRequestId()).toBe('outer');
      runWithContext({ requestId: 'inner' }, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });
});

describe('stampRequestId logger format', () => {
  it('stamps requestId from the active context when not already set', () => {
    runWithContext({ requestId: 'rid-stamp' }, () => {
      const info = { level: 'info', message: 'x' };
      stampRequestId(info);
      expect(info.requestId).toBe('rid-stamp');
    });
  });

  it('does not overwrite an explicitly-provided requestId', () => {
    runWithContext({ requestId: 'rid-ctx' }, () => {
      const info = { level: 'info', message: 'x', requestId: 'explicit' };
      stampRequestId(info);
      expect(info.requestId).toBe('explicit');
    });
  });

  it('is a no-op outside any request context', () => {
    const info = { level: 'info', message: 'x' };
    stampRequestId(info);
    expect(info.requestId).toBeUndefined();
  });
});

describe('end-to-end: log line carries requestId when emitted within a context', () => {
  it('serialized JSON includes the context requestId', () => {
    const lines = [];
    const captureStream = new (require('stream').Writable)({
      write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
    });
    const testLogger = winston.createLogger({
      transports: [
        new winston.transports.Stream({
          stream: captureStream,
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format((info) => stampRequestId(info))(),
            winston.format.json()
          ),
        }),
      ],
    });
    runWithContext({ requestId: 'rid-e2e' }, () => {
      testLogger.info('inside request');
    });
    const output = lines.join('');
    expect(output).toMatch(/"requestId":"rid-e2e"/);
    expect(output).toMatch(/inside request/);
  });
});
