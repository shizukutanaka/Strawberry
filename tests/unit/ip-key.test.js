// tests/unit/ip-key.test.js
//
// src/api/middleware/ip-key.js のレート制限キー生成を直接検証する。
// authLimiter 等のブルートフォース対策が IP 単位のバケットに依存するため、
// IPv6 /64 畳み込み（1 顧客割り当て単位で 1 バケット）と X-Forwarded-For
// 偽装耐性（TRUST_PROXY は hop 数のみ受理）がセキュリティ不変条件。

const { normalizeIpKey, rawClientIp, rateLimitKeyGenerator } = require('../../src/api/middleware/ip-key');

describe('normalizeIpKey — IPv6 /64 畳み込み', () => {
  test('同一 /64 内の異なる IPv6 アドレスが同じキーに畳み込まれる（アドレス回しバイパス防止）', () => {
    const a = '2001:db8:1234:5678::1';
    const b = '2001:db8:1234:5678:aaaa:bbbb:cccc:dddd';
    expect(normalizeIpKey(a)).toBe(normalizeIpKey(b));
    expect(normalizeIpKey(a)).toBe('2001:db8:1234:5678::/64');
  });

  test('異なる /64 プレフィックスは別キー', () => {
    expect(normalizeIpKey('2001:db8:1234:5678::1')).not.toBe(normalizeIpKey('2001:db8:1234:9999::1'));
  });

  test('IPv4 はそのまま返す（/24 等への畳み込みはしない）', () => {
    expect(normalizeIpKey('192.168.1.1')).toBe('192.168.1.1');
  });

  test('IPv4-mapped IPv6 (::ffff:x.x.x.x) は内側の IPv4 として畳み込まない', () => {
    expect(normalizeIpKey('::ffff:192.168.1.1')).toBe('192.168.1.1');
  });

  test('link-local の %zone 識別子を除去して /64 に畳み込む', () => {
    expect(normalizeIpKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  test('空文字・非文字列・非IPは安全側でそのまま or "unknown"', () => {
    expect(normalizeIpKey('')).toBe('unknown');
    expect(normalizeIpKey(undefined)).toBe('unknown');
    expect(normalizeIpKey('not-an-ip')).toBe('not-an-ip');
  });
});

describe('rawClientIp — TRUST_PROXY hop セマンティクス', () => {
  const origTrustProxy = process.env.TRUST_PROXY;
  afterEach(() => {
    if (origTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = origTrustProxy;
  });

  const req = (over = {}) => ({ ip: '1.2.3.4', socket: { remoteAddress: '10.0.0.9' }, ...over });

  test('TRUST_PROXY 未設定なら実 TCP ピア（socket.remoteAddress）を使う', () => {
    delete process.env.TRUST_PROXY;
    expect(rawClientIp(req())).toBe('10.0.0.9');
  });

  test('TRUST_PROXY が正の整数 hop 数なら req.ip（プロキシ解決済み）を信頼する', () => {
    process.env.TRUST_PROXY = '1';
    expect(rawClientIp(req())).toBe('1.2.3.4');
  });

  test.each([['true'], ['yes'], ['0'], ['-1'], ['abc']])(
    'TRUST_PROXY=%s（非整数/非正値）は信頼しない — XFF 左端偽装で全バイパスされるため',
    (v) => {
      process.env.TRUST_PROXY = v;
      expect(rawClientIp(req())).toBe('10.0.0.9');
    }
  );
});

describe('rateLimitKeyGenerator', () => {
  test('TRUST_PROXY 未設定では実ピア IP の /64 畳み込みキーを返す', () => {
    delete process.env.TRUST_PROXY;
    const req = { socket: { remoteAddress: '2001:db8:abcd:1234:1111:2222:3333:4444' } };
    expect(rateLimitKeyGenerator(req)).toBe('2001:db8:abcd:1234::/64');
  });
});
