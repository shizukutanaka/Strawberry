// OpenAPI仕様のRBAC要件自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');

describe('OpenAPI RBAC要件', () => {
  let openapi;
  beforeAll(() => {
    const specPath = path.join(__dirname, '../../openapi.json');
    openapi = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  });

  it('/system/infoはadminロールのみ許可', () => {
    const sysInfo = openapi.paths['/system/info']?.get;
    expect(sysInfo).toBeDefined();
    expect(sysInfo['x-required-role']).toBe('admin');
    expect(sysInfo.security).toEqual([{ BearerAuth: [] }]);
  });

  it('全APIにBearer認証が付与されている', () => {
    for (const [path, methods] of Object.entries(openapi.paths)) {
      for (const [method, def] of Object.entries(methods)) {
        expect(def.security).toBeDefined();
        expect(def.security[0]).toHaveProperty('BearerAuth');
      }
    }
  });
});
