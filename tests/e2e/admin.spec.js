// tests/e2e/admin.spec.js — the admin dashboard (#/admin): stats cards from
// /admin/stats, verification table, ops buttons,
// and route gating for non-admin users.
const { test, expect } = require('@playwright/test');
const { apiRegisterAndLogin, registerAndLoginUI, loginUI, promoteToAdmin, trackConsoleErrors } = require('./helpers');

test.describe('admin dashboard', () => {
  test('renders stats and verification sections for admin', async ({ page, request, baseURL }) => {
    const consoleErrors = trackConsoleErrors(page);
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'dashadm' });
    await promoteToAdmin(request, baseURL, admin.email, admin.password);

    await loginUI(page, admin.email, admin.password);
    await page.goto('/#/admin');

    // 統計カード（ユーザー/GPU/注文）が描画される
    await expect(page.locator('text=管理ダッシュボード')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=検証監査')).toBeVisible();
    // 検証はデータなし → 空状態、またはデータテーブルのどちらか
    await expect(page.locator('.empty-state, table.data-table').first()).toBeVisible({ timeout: 5000 });
    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('non-admin cannot see the nav link or access the route', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'nodash' });
    await expect(page.locator('#nav a[href="#/admin"]')).toHaveCount(0);

    await page.goto('/#/admin');
    await expect(page.locator('text=アクセス権限がありません')).toBeVisible({ timeout: 5000 });
  });
});
