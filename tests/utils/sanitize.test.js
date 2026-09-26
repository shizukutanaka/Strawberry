// tests/utils/sanitize.test.js
// sanitizeSensitiveFields の DoS 回帰テスト。
// 旧実装は深度無制限の再帰で、~8,000 段のネスト JSON（≈48KB、express の
// 100KB body 上限内に収まる）を audit ミドルウェアの req.body マスクが
// 受けると Maximum call stack size exceeded → プロセス終了だった。
// また循環オブジェクトでも無限再帰していた。
const { sanitizeSensitiveFields, sanitizeString } = require('../../src/utils/sanitize');

function makeDeepJson(depth) {
  return JSON.parse('{"a":'.repeat(depth) + '1' + '}'.repeat(depth));
}

describe('sanitizeSensitiveFields', () => {
  it('masks sensitive keys case-insensitively and recursively', () => {
    const out = sanitizeSensitiveFields({
      password: 'pw', nested: { TOKEN: 't', safe: 'ok' }, list: [{ secret: 's' }, 1],
    });
    expect(out.password).toBe('[MASKED]');
    expect(out.nested.TOKEN).toBe('[MASKED]');
    expect(out.nested.safe).toBe('ok');
    expect(out.list[0].secret).toBe('[MASKED]');
    expect(out.list[1]).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = { password: 'pw', keep: 'v' };
    sanitizeSensitiveFields(input);
    expect(input.password).toBe('pw');
  });

  it('survives JSON bodies deeper than the V8 recursion limit (DoS regression)', () => {
    // 8,000 段 ≈ 48KB — body-parser の既定上限内で旧実装をクラッシュさせた深さ
    const out = sanitizeSensitiveFields(makeDeepJson(8000));
    // 32 段を超えた部分は '[TRUNCATED]' に置き換わる
    let node = out;
    for (let i = 0; i < 33; i++) node = node.a;
    expect(node).toBe('[TRUNCATED]');
  });

  it('breaks circular references instead of recursing forever', () => {
    const obj = { name: 'x' };
    obj.self = obj;
    const out = sanitizeSensitiveFields(obj);
    expect(out.self).toBe('[CIRCULAR]');
    expect(out.name).toBe('x');
  });

  it('does not false-positive on shared (non-circular) subobjects', () => {
    const shared = { v: 1 };
    const out = sanitizeSensitiveFields({ a: shared, b: shared });
    // 兄弟で同じオブジェクトを参照しても循環ではないのでそのまま残る
    expect(out.a).toEqual({ v: 1 });
    expect(out.b).toEqual({ v: 1 });
  });

  it('masks keys inside arrays at nested depth', () => {
    const out = sanitizeSensitiveFields({ arr: [[[{ apiKey: 'k' }]]] });
    expect(out.arr[0][0][0].apiKey).toBe('[MASKED]');
  });
});

describe('sanitizeString', () => {
  it('strips tags and residual angle brackets', () => {
    expect(sanitizeString('<<script>alert(1)</script>')).not.toContain('<');
    expect(sanitizeString('<b>hi</b>')).toBe('hi');
  });
});
