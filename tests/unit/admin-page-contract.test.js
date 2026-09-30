// tests/unit/admin-page-contract.test.js — SPA admin ページと api.js / 実ルートの契約。
// ページが呼ぶ api.* メソッドが api.js に存在し、そのパスが実際に
// src/api/routes/index.js の admin エンドポイントに一致することを検証する
// （フロントエンドが架空のパスを呼ぶ事故の回帰ガード）。
const fs = require('fs');
const path = require('path');

const ADMIN_PAGE = path.join(__dirname, '../../public/js/pages/admin.js');
const API_JS = path.join(__dirname, '../../public/js/api.js');
const ROUTES_INDEX = path.join(__dirname, '../../src/api/routes/index.js');

const adminSrc = fs.readFileSync(ADMIN_PAGE, 'utf-8');
const apiSrc = fs.readFileSync(API_JS, 'utf-8');
const routesSrc = fs.readFileSync(ROUTES_INDEX, 'utf-8');

describe('admin page contract', () => {
  it('admin.js は api.js に存在する admin.* メソッドのみを呼ぶ', () => {
    const called = [...adminSrc.matchAll(/api\.(admin\w+)/g)].map((m) => m[1]);
    const defined = new Set([...apiSrc.matchAll(/^\s*(admin\w+):/gm)].map((m) => m[1]));
    expect(called.length).toBeGreaterThanOrEqual(4);
    for (const name of called) {
      expect(defined.has(name)).toBe(true);
    }
  });

  it('api.js の admin.* が指すパスは routes/index.js に実在する', () => {
    const paths = [...apiSrc.matchAll(/admin\w+:\s*\([^)]*\)\s*=>\s*request\('([^']+)'/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    for (const p of paths) {
      const routePath = p.replace('/api/v1', '');
      // ルート定義は '/admin/...' 形式
      expect(routesSrc).toContain(`'${routePath}'`);
    }
  });

  it('admin.js は innerHTML にユーザー由来データを渡さない', () => {
    expect(adminSrc).not.toMatch(/innerHTML/);
    expect(adminSrc).not.toMatch(/insertAdjacentHTML/);
  });
});
