// tests/unit/lightning-service-rpc-deadline.test.js
// lightning-service.js の LND クライアントに付ける既定 deadline（gRPC service_config の
// methodConfig.timeout）を検証。deadline 未設定だと LND が接続を保ったまま応答しない
// 障害時に資金移動 RPC（AddInvoice/SendPaymentSync/SettleInvoice 等）が無期限滞留する。
const { buildLndChannelOptions, LND_UNARY_METHODS } = require('../../lightning-service');

describe('buildLndChannelOptions: LND unary RPC の既定 deadline', () => {
  const parse = (opts) => JSON.parse(opts['grpc.service_config']);

  test('既定では全 unary メソッドに 60s の methodConfig.timeout が付く', () => {
    const opts = buildLndChannelOptions();
    const cfg = parse(opts);
    const mc = cfg.methodConfig[0];
    expect(mc.timeout).toBe('60s');
    // 全 unary メソッドが列挙されている
    const names = mc.name.map(n => `${n.service}.${n.method}`);
    for (const m of LND_UNARY_METHODS) {
      expect(names).toContain(`lnrpc.Lightning.${m}`);
    }
    // 長寿命ストリーム（Subscribe系/CloseChannel）は対象外
    expect(names.join(',')).not.toMatch(/Subscribe|CloseChannel/);
    expect(names.length).toBe(LND_UNARY_METHODS.length);
  });

  test('LND_RPC_TIMEOUT_MS で可変（明示引数優先）', () => {
    expect(parse(buildLndChannelOptions(5000)).methodConfig[0].timeout).toBe('5s');
    expect(parse(buildLndChannelOptions(1500)).methodConfig[0].timeout).toBe('1.5s');
  });

  test('不正な env 値では 60s にフォールバック（無効 JSON でチャネル作成を壊さない）', () => {
    const saved = process.env.LND_RPC_TIMEOUT_MS;
    try {
      process.env.LND_RPC_TIMEOUT_MS = 'not-a-number';
      expect(parse(buildLndChannelOptions()).methodConfig[0].timeout).toBe('60s');
      process.env.LND_RPC_TIMEOUT_MS = '5000';
      expect(parse(buildLndChannelOptions()).methodConfig[0].timeout).toBe('5s');
    } finally {
      if (saved === undefined) delete process.env.LND_RPC_TIMEOUT_MS;
      else process.env.LND_RPC_TIMEOUT_MS = saved;
    }
  });
});
