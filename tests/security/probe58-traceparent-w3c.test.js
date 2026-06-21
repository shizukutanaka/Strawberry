// tests/security/probe58-traceparent-w3c.test.js
// Probe 58 (completes D-2): W3C Trace Context (traceparent) ingestion. A valid inbound
// traceparent's trace-id is parsed, propagated through the AsyncLocalStorage context,
// and stamped onto logs so logs correlate across services. Malformed/invalid values
// are rejected (never pollute logs with an untrusted trace-id).

const winston = require('winston');
const { parseTraceId, runWithContext, getTraceId } = require('../../src/utils/request-context');
const { stampRequestId } = require('../../src/utils/logger');

const VALID = '00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

describe('parseTraceId (W3C traceparent)', () => {
  it('extracts the 32-hex trace-id from a valid traceparent', () => {
    expect(parseTraceId(VALID)).toBe(TRACE_ID);
  });

  it('accepts the unsampled flag (00) too', () => {
    expect(parseTraceId('00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-00')).toBe(TRACE_ID);
  });

  it('rejects malformed values', () => {
    expect(parseTraceId(undefined)).toBeNull();
    expect(parseTraceId('')).toBeNull();
    expect(parseTraceId('garbage')).toBeNull();
    expect(parseTraceId('00-tooshort-b9c7c989f97918e1-01')).toBeNull();
    expect(parseTraceId('00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1')).toBeNull(); // missing flags
    expect(parseTraceId('00-0AF7651916CD43DD8448EB211C80319C-b9c7c989f97918e1-01')).toBeNull(); // uppercase not allowed
  });

  it('rejects reserved version ff and all-zero trace/parent ids', () => {
    expect(parseTraceId('ff-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01')).toBeNull();
    expect(parseTraceId('00-00000000000000000000000000000000-b9c7c989f97918e1-01')).toBeNull();
    expect(parseTraceId('00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01')).toBeNull();
  });
});

describe('traceId propagation through context + logs', () => {
  it('getTraceId returns the context trace-id', () => {
    runWithContext({ requestId: 'r', traceId: TRACE_ID }, () => {
      expect(getTraceId()).toBe(TRACE_ID);
    });
  });

  it('stampRequestId stamps traceId from the active context', () => {
    runWithContext({ requestId: 'r', traceId: TRACE_ID }, () => {
      const info = { level: 'info', message: 'x' };
      stampRequestId(info);
      expect(info.traceId).toBe(TRACE_ID);
    });
  });

  it('does not stamp traceId when none is in context', () => {
    runWithContext({ requestId: 'r', traceId: undefined }, () => {
      const info = { level: 'info', message: 'x' };
      stampRequestId(info);
      expect(info.traceId).toBeUndefined();
    });
  });

  it('end-to-end: serialized log line carries the trace-id', () => {
    const lines = [];
    const stream = new (require('stream').Writable)({
      write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); },
    });
    const log = winston.createLogger({
      transports: [new winston.transports.Stream({
        stream,
        format: winston.format.combine(
          winston.format((info) => stampRequestId(info))(),
          winston.format.json()
        ),
      })],
    });
    runWithContext({ requestId: 'r', traceId: TRACE_ID }, () => log.info('hi'));
    expect(lines.join('')).toMatch(new RegExp(`"traceId":"${TRACE_ID}"`));
  });
});

describe('middleware wiring (source)', () => {
  it('logger.js middleware parses traceparent and runs in context', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/middleware/logger.js'), 'utf-8'
    );
    expect(src).toMatch(/parseTraceId\(req\.headers\['traceparent'\]\)/);
    expect(src).toMatch(/runWithContext\(\{\s*requestId: req\.id,\s*traceId\s*\}/);
  });
});
