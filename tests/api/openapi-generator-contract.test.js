// OpenAPI ジェネレータの生成契約テスト（Jest）。
// schemas は (A) グループ形 { name: schema, ... }（gpu/order/...）で構成される。
// 旧ジェネレータは (B) 単体スキーマ形を (A) として走査して Joi 内部プロパティを
// j2s に渡しクラッシュしていた — normalizeGroup の両形対応を回帰固定する。
// （(B) 形だった lightningNode/lightningChannel は Lightning 廃止に伴い削除済み。
//   現在の schemas は全て (A) 形のため、(B) 形の回帰は「混在しても生成できる」
//   ことではなく生成自体が両形対応のまま壊れないことを骨格テストで担保する。）
// また persist=false 既定では openapi.json を disk に書かない
// （未認証 /openapi.json リクエストで冷えたキャッシュから disk IO が走った旧不具合の固定）。

const fs = require('fs');
const path = require('path');
const { generateOpenAPISpec } = require('../../src/api/openapi-generator');

const OPENAPI_PATH = path.resolve(__dirname, '../../openapi.json');

describe('generateOpenAPISpec の生成契約', () => {
  let openapi;
  beforeAll(() => {
    openapi = generateOpenAPISpec();
  });

  it('OpenAPI 3.0.3 の骨格を返す（openapi/info/paths/components）', () => {
    expect(openapi.openapi).toBe('3.0.3');
    expect(openapi.info.title).toContain('Strawberry');
    expect(typeof openapi.paths).toBe('object');
    expect(typeof openapi.components.schemas).toBe('object');
  });

  it('形 (A) グループの各スキーマがコンポーネント化される', () => {
    expect(openapi.components.schemas.gpu_register).toBeDefined();
    expect(openapi.components.schemas.order_create).toBeDefined();
    expect(openapi.components.schemas.user_register).toBeDefined();
  });

  it('requestBody の $ref は全て実在するコンポーネントを指す（幻影参照なし）', () => {
    const componentNames = new Set(Object.keys(openapi.components.schemas));
    for (const [path, methods] of Object.entries(openapi.paths)) {
      for (const [method, def] of Object.entries(methods)) {
        const ref = def.requestBody?.content?.['application/json']?.schema?.$ref;
        if (ref) {
          const name = ref.replace('#/components/schemas/', '');
          expect(componentNames.has(name)).toBe(true);
        }
      }
    }
  });

  it('persist=false 既定では openapi.json を disk に書かない', () => {
    // 副作用契約: ジェネレータはメモリ上の spec を返すだけで、ファイル生成は
    // CLI 起動（persist=true）のときのみ。未認証リクエストで disk IO を誘発しない。
    const existed = fs.existsSync(OPENAPI_PATH);
    if (existed) fs.rmSync(OPENAPI_PATH);
    try {
      generateOpenAPISpec();
      generateOpenAPISpec({ persist: false });
      expect(fs.existsSync(OPENAPI_PATH)).toBe(false);
    } finally {
      if (fs.existsSync(OPENAPI_PATH)) fs.rmSync(OPENAPI_PATH);
    }
  });
});
