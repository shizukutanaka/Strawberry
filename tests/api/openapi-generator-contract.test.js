// OpenAPI ジェネレータの生成契約テスト（Jest）。
// schemas には (A) グループ形 { name: schema, ... }（gpu/order/...）と
// (B) 単体スキーマ形（lightningNode/lightningChannel）の2形態が混在する。
// 旧ジェネレータは (B) を (A) として走査して Joi 内部プロパティを j2s に渡し
// クラッシュしていた — normalizeGroup の両形対応を回帰固定する。
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

  it('形 (B) 単体スキーマもコンポーネント化される（過去のクラッシュ経路）', () => {
    // lightningNode はグループを持たない単体 Joi スキーマ — normalizeGroup が
    // { lightningNode: schema } として代表名を付けないと components から欠落する。
    expect(openapi.components.schemas.lightningNode_lightningNode).toBeDefined();
    expect(openapi.components.schemas.lightningChannel_lightningChannel).toBeDefined();
  });

  it('形 (A) グループの各スキーマがコンポーネント化される', () => {
    expect(openapi.components.schemas.gpu_register).toBeDefined();
    expect(openapi.components.schemas.order_create).toBeDefined();
    expect(openapi.components.schemas.user_register).toBeDefined();
    expect(openapi.components.schemas.payment_createInvoice).toBeDefined();
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
