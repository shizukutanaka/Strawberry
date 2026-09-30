// instrumentation.js — OTel ゲーティングの不変条件
// OTEL_EXPORTER_OTLP_ENDPOINT 未設定時は ~140 個の @opentelemetry/* を一切
// require してはいけない（server.js が最初に require するため、誤って無条件化
// すると全テスト・全起動で SDK 初期化コストが発生する）。
const MODULE = '../../src/telemetry/instrumentation';

describe('telemetry instrumentation gating', () => {
  const savedEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedEnv;
    jest.resetModules();
  });

  it('is a no-op and loads zero @opentelemetry packages when endpoint is unset', () => {
    // intercept require to detect any @opentelemetry load
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    const loaded = [];
    Module._resolveFilename = function (request, ...args) {
      if (request.startsWith('@opentelemetry/')) loaded.push(request);
      return origResolve.call(this, request, ...args);
    };
    try {
      require(MODULE);
    } finally {
      Module._resolveFilename = origResolve;
    }
    expect(loaded).toEqual([]);
  });

  it('does not register signal handlers when endpoint is unset', () => {
    const before = process.listenerCount('SIGTERM');
    require(MODULE);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
