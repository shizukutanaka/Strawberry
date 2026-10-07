// tests/utils/config.test.js
// config.json マージの回帰テスト。旧実装は { ...defaultConfig, ...fileConfig }
// の浅いマージで、部分ファイルが兄弟既定値を全消しし、かつ getConfig の
// fileConfig || envConfig で環境変数オーバーライドを丸ごと捨てていた。
const { _deepMergeConfig } = require('../../src/utils/config');

describe('deepMergeConfig', () => {
  const base = {
    server: { port: 3000, host: 'localhost', corsOrigins: '*', rateLimitMax: 100 },
    gpu: { minMemoryGB: 4 },
    list: [1, 2],
  };

  it('overrides a nested key while preserving sibling defaults', () => {
    const out = _deepMergeConfig(base, { server: { port: 4000 } });
    expect(out.server.port).toBe(4000);
    // 旧実装はここが全て undefined になっていた
    expect(out.server.host).toBe('localhost');
    expect(out.server.corsOrigins).toBe('*');
    expect(out.server.rateLimitMax).toBe(100);
    expect(out.gpu.minMemoryGB).toBe(4);
  });

  it('replaces arrays wholesale instead of element-merging them', () => {
    const out = _deepMergeConfig(base, { list: [9] });
    expect(out.list).toEqual([9]);
  });

  it('adds new sections and keeps scalars override-able', () => {
    const out = _deepMergeConfig(base, { newSection: { a: 1 }, gpu: { minMemoryGB: 8 } });
    expect(out.newSection.a).toBe(1);
    expect(out.gpu.minMemoryGB).toBe(8);
  });

  it('does not mutate the base object', () => {
    _deepMergeConfig(base, { server: { port: 4000 } });
    expect(base.server.port).toBe(3000);
  });

  it('skips __proto__/constructor/prototype keys (no prototype pollution)', () => {
    const poison = JSON.parse('{"__proto__":{"polluted":true},"server":{"port":4000}}');
    const out = _deepMergeConfig(base, poison);
    expect(out.server.port).toBe(4000);
    expect({}.polluted).toBeUndefined();
    expect(out.polluted).toBeUndefined();
  });

  it('handles empty/null override gracefully', () => {
    expect(_deepMergeConfig(base, null)).toEqual(base);
    expect(_deepMergeConfig(base, {})).toEqual(base);
  });
});

// validateConfigShape（弱所#9）: config.json の綴りミスキーと型違反の検出。
// require は上部で済んでいるので内部関数を直接検証する。
const { _validateConfigShape } = require('../../src/utils/config');

describe('validateConfigShape', () => {
  it('flags unknown keys (typos like "sever") as silently-ignored problems', () => {
    const problems = _validateConfigShape({ sever: { port: 1 } });
    expect(problems.some((p) => p.includes('sever'))).toBe(true);
  });

  it('flags type mismatches on known leaf keys', () => {
    const problems = _validateConfigShape({ server: { port: 'abc' } });
    expect(problems.some((p) => p.includes('server.port') && p.includes('number'))).toBe(true);
  });

  it('flags object-vs-scalar shape mismatches', () => {
    const problems = _validateConfigShape({ server: 'oops' });
    expect(problems.some((p) => p.includes('server'))).toBe(true);
  });

  it('does not print the offending value (secrets in config.json must not reach logs)', () => {
    const problems = _validateConfigShape({ security: { jwtSecret: 12345 } });
    expect(problems.some((p) => p.includes('12345'))).toBe(false);
  });

  it('returns no problems for a well-formed partial config', () => {
    const problems = _validateConfigShape({ server: { port: 4000 }, gpu: { minMemoryGB: 8 } });
    expect(problems).toEqual([]);
  });
});
