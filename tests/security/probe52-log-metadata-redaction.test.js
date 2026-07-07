// tests/security/probe52-log-metadata-redaction.test.js
// Probe 52 regression tests (Qiita/Zenn structured-logging / PII-masking review):
// 52a: redactLogInfo masks sensitive winston METADATA splat (logger.x('msg', {meta}))
//      — not just object-form messages. Previously metadata fields (password/apiKey/
//      token in e.g. { body: req.body }) were serialized to combined.log unredacted.
// 52b: the redaction filter runs BEFORE json() in the file transports (a filter after
//      json() is a no-op because json() has already frozen the serialized output).
// 52c: end-to-end — a logger using the same pipeline never emits the raw secret.

const winston = require('winston');
const { redactLogInfo } = require('../../src/utils/logger');

describe('redactLogInfo: metadata splat masking', () => {
  it('masks a top-level sensitive metadata key (apiKey)', () => {
    const info = { level: 'info', message: 'op done', apiKey: 'super-secret-key' };
    redactLogInfo(info);
    expect(info.apiKey).toBe('[MASKED]');
    expect(info.message).toBe('op done'); // string message untouched
  });

  it('recursively masks secrets nested in metadata (e.g. { body: req.body })', () => {
    const info = {
      level: 'error',
      message: 'Payment failed',
      body: { amount: 5, password: 'hunter2', token: 'abc.def.ghi' },
    };
    redactLogInfo(info);
    expect(info.body.password).toBe('[MASKED]');
    expect(info.body.token).toBe('[MASKED]');
    expect(info.body.amount).toBe(5); // non-sensitive preserved
    expect(info.message).toBe('Payment failed');
  });

  it('sanitizes an object-form message too', () => {
    const info = { level: 'info', message: { user: 'u1', secret: 's3cr3t' } };
    redactLogInfo(info);
    expect(info.message.secret).toBe('[MASKED]');
    expect(info.message.user).toBe('u1');
  });

  it('mutates in place (returns the same info object — preserves winston symbols)', () => {
    const info = { level: 'info', message: 'x', password: 'p' };
    const out = redactLogInfo(info);
    expect(out).toBe(info);
  });

  it('does not clobber reserved fields (level/message/timestamp)', () => {
    const info = { level: 'warn', message: 'hi', timestamp: '2026-01-01T00:00:00Z' };
    redactLogInfo(info);
    expect(info.level).toBe('warn');
    expect(info.message).toBe('hi');
    expect(info.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('survives circular references in metadata (no stack overflow)', () => {
    // Reproduces the real-world crash: axios errors have error.request <-> response
    // cycles. The masker must terminate, not throw "Maximum call stack size exceeded".
    const a = { password: 'p' };
    const b = { parent: a };
    a.child = b; // a -> b -> a cycle
    const info = { level: 'error', message: 'boom', err: a };
    expect(() => redactLogInfo(info)).not.toThrow();
    expect(info.err.password).toBe('[MASKED]');
  });

  it('does not descend into exotic objects (Error instances) that carry cycles', () => {
    const err = new Error('kaboom');
    err.config = {}; err.config.self = err.config; // self-cycle on a plain sub-object
    const info = { level: 'error', message: 'req failed', error: err };
    expect(() => redactLogInfo(info)).not.toThrow();
  });
});

describe('logger.js: redaction is applied before json() in file transports', () => {
  const src = require('fs').readFileSync(
    require.resolve('../../src/utils/logger.js'), 'utf-8'
  );

  it('file transport combine order is timestamp → redactLogInfo → json', () => {
    // The redact filter must appear before json() in the source (otherwise json()
    // has already serialized the unredacted record).
    const redactIdx = src.indexOf('redactLogInfo(info))()');
    const jsonIdx = src.indexOf('winston.format.json()', redactIdx);
    expect(redactIdx).toBeGreaterThan(-1);
    expect(jsonIdx).toBeGreaterThan(redactIdx);
  });
});

describe('end-to-end: serialized log output never contains the raw secret', () => {
  it('a logger using the same pipeline masks metadata in the JSON line', () => {
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
            winston.format((info) => redactLogInfo(info))(),
            winston.format.json()
          ),
        }),
      ],
    });
    testLogger.error('Payment failed', { body: { password: 'hunter2', amount: 5 }, apiKey: 'leak-me' });
    const output = lines.join('');
    expect(output).not.toMatch(/hunter2/);
    expect(output).not.toMatch(/leak-me/);
    expect(output).toMatch(/\[MASKED\]/);
    expect(output).toMatch(/Payment failed/); // the non-secret message survives
    expect(output).toMatch(/"amount":5/); // non-secret metadata survives
  });
});
