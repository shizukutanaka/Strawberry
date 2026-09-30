// tests/e2e/auth-refresh.spec.js — SPA の refresh-token セッション継続回帰テスト。
//
// 背景: 従来のフロントエンドはログイン時に refreshToken を破棄し、
// アクセストークン（TTL 1h）が切れるたびに強制再ログインさせられていた。
// 401 → POST /users/refresh → 同一リクエスト再試行 → セッション継続を確認する。
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI } = require('./helpers');

test.describe('token refresh', () => {
  test('login stores a refresh token', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'ref' });
    const refreshToken = await page.evaluate(() => localStorage.getItem('strawberry.refreshToken'));
    expect(refreshToken).toBeTruthy();
  });

  test('expired access token silently refreshes and keeps the session', async ({ page, request, baseURL }) => {
    await registerAndLoginUI(page, { prefix: 'ref' });
    const refreshToken = await page.evaluate(() => localStorage.getItem('strawberry.refreshToken'));
    expect(refreshToken).toBeTruthy();

    // アクセストークンを期限切れ相当（形式は妥当だが署名が無効な JWT）に
    // 置き換える。ルートガードは isAuthenticated()（トークン存在のみ）を通るが、
    // API 呼び出しは 401 になり refresh→再試行経路が走る。
    await page.evaluate(() => localStorage.setItem('strawberry.token', 'expired.invalid.token'));
    await page.goto('/#/orders');

    // リフレッシュが成功して新しいアクセストークンが書き戻され、
    // ログインへ飛ばされないことを確認する。
    await page.waitForFunction(
      () => localStorage.getItem('strawberry.token') !== 'expired.invalid.token'
        && !!localStorage.getItem('strawberry.token'),
      { timeout: 8000 }
    );
    await page.waitForFunction(() => location.hash === '#/orders', { timeout: 8000 });

    // ローテーション: 旧 refresh token は失効済み（再利用は 401）。
    const staleRefresh = await request.post(`${baseURL}/api/v1/users/refresh`, {
      data: { refreshToken },
    });
    expect(staleRefresh.status()).toBe(401);
  });

  test('logout revokes the refresh token server-side', async ({ page, request, baseURL }) => {
    await registerAndLoginUI(page, { prefix: 'ref' });
    const refreshToken = await page.evaluate(() => localStorage.getItem('strawberry.refreshToken'));
    expect(refreshToken).toBeTruthy();

    await page.click('text=ログアウト');
    await page.waitForFunction(() => location.hash.startsWith('#/login'), { timeout: 8000 });

    // ローカルセッションは完全に消える
    const cleared = await page.evaluate(() => ({
      token: localStorage.getItem('strawberry.token'),
      refresh: localStorage.getItem('strawberry.refreshToken'),
    }));
    expect(cleared).toEqual({ token: null, refresh: null });

    // サーバ側でも refresh jti が失効している → 再提示は 401。
    const res = await request.post(`${baseURL}/api/v1/users/refresh`, {
      data: { refreshToken },
    });
    expect(res.status()).toBe(401);
  });
});
