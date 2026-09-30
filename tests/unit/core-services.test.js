// tests/unit/core-services.test.js
//
// src/core/services.js のガード契約を直接検証する。
//
// gpu-detector / virtual-gpu-manager / p2p-network / lightning-service は
// ネイティブ・ESM・gRPC 依存を持つ任意サービスで、未導入環境では
// safeLoad が null にフォールバックする。requireService は null の
// サービスを使うエンドポイントで 503 を返す共通ゲート。

const services = require('../../src/core/services');
const { requireService } = services;

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

describe('requireService ゲート', () => {
  test('サービスが利用可能なら true を返しレスポンスを書かない', () => {
    const res = makeRes();
    expect(requireService({}, res)).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  test('サービスが null（未導入/初期化失敗）なら 503 を返して false', () => {
    const res = makeRes();
    expect(requireService(null, res)).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Service unavailable/);
  });
});

describe('safeLoad のフォールバック', () => {
  test('4サービスのエクスポートが定義されている（利用可否は環境依存のため null も許容）', () => {
    for (const key of ['gpuDetector', 'vgpuManager', 'p2pNetwork', 'lightning']) {
      expect(key in services).toBe(true);
    }
  });

  test('任意依存が未導入でもモジュール自体は require できる（起動を阻害しない設計の回帰防止）', () => {
    // このテスト自体が services.js の require 成功を意味する
    // 失敗していたら describe ブロック到達前に MODULE_NOT_FOUND で落ちる
    expect(services).toBeTruthy();
  });
});
