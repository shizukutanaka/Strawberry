// OpenAPI仕様のRBAC要件自動テスト（Jest）
// ジェネレータの戻り値を直接検証する（成果物ファイル非依存）。
// 以前はテスト内で generateOpenAPISpec() を呼んだ後 openapi.json をディスクから
// 読んでいたが、ジェネレータが persist:false 既定（disk write を廃し spec を返す
// 方式）へ変わって以降、クリーンなチェックアウトでは openapi.json が存在せず
// 必ず ENOENT で赤になっていた。戻り値を使えば副作用ファイルに依存しない。
const { generateOpenAPISpec } = require('../../src/api/openapi-generator');

describe('OpenAPI RBAC要件', () => {
  let openapi;
  beforeAll(() => {
    openapi = generateOpenAPISpec();
  });

  it('/system/infoはadminロールのみ許可', () => {
    const sysInfo = openapi.paths['/system/info']?.get;
    expect(sysInfo).toBeDefined();
    expect(sysInfo['x-required-role']).toBe('admin');
    expect(sysInfo.security).toEqual([{ BearerAuth: [] }]);
  });

  it('全APIにBearer認証が付与されている', () => {
    for (const [, methods] of Object.entries(openapi.paths)) {
      for (const [, def] of Object.entries(methods)) {
        expect(def.security).toBeDefined();
        expect(def.security[0]).toHaveProperty('BearerAuth');
      }
    }
  });
});
