// SSRF guard tests — IP classification and resolve-time URL validation.
// The resolve-time check is what defeats DNS rebinding and alternate IP
// encodings that the pure-regex check misses.
const { isPrivateIp, assertPublicUrl } = require('../../src/utils/ssrf-guard');

describe('isPrivateIp', () => {
  it('flags IPv4 loopback / RFC1918 / link-local / CGNAT as private', () => {
    for (const ip of [
      '127.0.0.1', '127.1.2.3', '0.0.0.0',
      '10.0.0.1', '10.255.255.255',
      '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',      // CGNAT
      '198.18.0.1',      // benchmark
      '224.0.0.1', '240.0.0.1', // multicast/reserved
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it('allows ordinary public IPv4 addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '192.167.1.1']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it('handles IPv6 loopback, link-local, ULA, and mapped IPv4', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true); // mapped loopback
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false); // public (cloudflare)
  });

  it('blocks malformed / non-IP input defensively', () => {
    expect(isPrivateIp('')).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp(null)).toBe(true);
    expect(isPrivateIp('999.999.999.999')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
  const rebindResolver = async () => [{ address: '127.0.0.1', family: 4 }];

  it('passes when the hostname resolves to a public address', async () => {
    await expect(assertPublicUrl('https://example.com/hook', publicResolver)).resolves.toBe(true);
  });

  it('blocks DNS rebinding: a public-looking hostname resolving to loopback', async () => {
    await expect(assertPublicUrl('https://evil.example.com/hook', rebindResolver))
      .rejects.toThrow(/private address 127\.0\.0\.1/);
  });

  it('blocks when ANY resolved address is private (mixed result)', async () => {
    const mixed = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    await expect(assertPublicUrl('https://example.com', mixed))
      .rejects.toThrow(/private address 10\.0\.0\.5/);
  });

  it('blocks literal private IP hosts without any DNS lookup', async () => {
    let called = false;
    const spy = async () => { called = true; return [{ address: '93.184.216.34' }]; };
    await expect(assertPublicUrl('http://127.0.0.1:8080/x', spy)).rejects.toThrow(/private\/reserved/);
    expect(called).toBe(false); // literal IP short-circuits, no resolver call
  });

  it('rejects non-http(s) schemes and malformed URLs', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', publicResolver)).rejects.toThrow(/unsupported scheme/);
    await expect(assertPublicUrl('not a url', publicResolver)).rejects.toThrow(/malformed URL/);
  });

  it('rejects when DNS resolution itself fails', async () => {
    const failing = async () => { throw new Error('ENOTFOUND'); };
    await expect(assertPublicUrl('https://nope.invalid', failing)).rejects.toThrow(/DNS resolution failed/);
  });
});
