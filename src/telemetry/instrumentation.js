// src/telemetry/instrumentation.js — minimal OpenTelemetry setup, required as
// literally the first statement in server.js (auto-instrumentation must patch
// modules like http/express before anything else requires them).
//
// No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set: this project has no
// collector running in development, CI, or this sandbox, and every other
// optional integration in this codebase (P2P network, Google/GitHub OAuth,
// real LND) already follows the same "absent config -> disabled, not broken"
// pattern (see src/core/services.js, lightning-service.js). Gating the
// require() calls themselves (not just sdk.start()) means the ~140
// @opentelemetry/* packages this pulls in are never loaded at all when
// telemetry isn't configured — zero cost to the jest suite, which imports
// server.js directly and has no such endpoint configured.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
  const { logger } = require('../utils/logger');

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'strawberry-api',
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    sdk.start();
    logger.info(`OpenTelemetry: started (endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT})`);
  } catch (e) {
    logger.warn(`OpenTelemetry: failed to start, continuing without tracing: ${e.message}`);
  }

  // グレースフルシャットダウン: バッファ済みスパンを送出してから終了する。
  // server.js 側の SIGTERM/SIGINT ハンドラより先に登録されるため、Node の
  // デフォルト順序（後入れ先実行ではなく登録順）でこちらが先に走る。
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
  process.on('SIGINT', () => sdk.shutdown().catch(() => {}));
}
