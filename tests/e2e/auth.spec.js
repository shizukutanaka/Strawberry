// tests/e2e/auth.spec.js — registration, login, role-gated nav, logout.
// This is the layer jest's supertest-based suite can't cover: real DOM
// rendering, the SPA's client-side routing, and CSP enforcement (a strict
// script-src 'self' with no inline scripts — any violation here fails
// silently in production and shows up as a console error in a real browser).
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, uniqueId, trackConsoleErrors } = require('./helpers');

test.describe('auth', () => {
  test('register as a renter, see renter nav, logout', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);

    await registerAndLoginUI(page, { prefix: 'renter' });

    // Renter nav: market + orders, but no provider-only links.
    await expect(page.locator('#nav a[href="#/market"]')).toBeVisible();
    await expect(page.locator('#nav a[href="#/orders"]')).toBeVisible();
    await expect(page.locator('#nav a[href="#/my-gpus"]')).toHaveCount(0);
    await expect(page.locator('#nav a[href="#/gpus/new"]')).toHaveCount(0);

    await page.click('button:has-text("ログアウト")');
    await page.waitForFunction(() => location.hash === '#/login', { timeout: 5000 });
    expect(await page.evaluate(() => localStorage.getItem('strawberry.token'))).toBeNull();

    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('register as a provider, see provider-only nav links', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'provider', role: 'provider' });
    await expect(page.locator('#nav a[href="#/my-gpus"]')).toBeVisible();
    await expect(page.locator('#nav a[href="#/gpus/new"]')).toBeVisible();
    await expect(page.locator('#nav a[href="#/earnings"]')).toBeVisible();
    await expect(page.locator('#nav a[href="#/admin/payments"]')).toHaveCount(0);
  });

  test('duplicate email registration shows a clear error, not a crash', async ({ page }) => {
    const user = await registerAndLoginUI(page, { prefix: 'dup' });
    await page.evaluate(() => localStorage.clear());

    await page.goto('/#/register');
    await page.waitForSelector('#reg-username');
    await page.fill('#reg-username', `dup${uniqueId()}`);
    await page.fill('#reg-email', user.email); // reuse the email
    await page.fill('#reg-password', 'Test1234!');
    await page.fill('#reg-password-confirm', 'Test1234!');
    await page.click('button[type="submit"]');

    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });
    // Still on the register page — no crash, no silent redirect.
    expect(page.url()).toContain('#/register');
  });

  test('wrong password shows an error and does not set a session', async ({ page }) => {
    const user = await registerAndLoginUI(page, { prefix: 'wrongpw' });
    await page.evaluate(() => localStorage.clear());

    await page.goto('/#/login');
    await page.waitForSelector('#login-email');
    await page.fill('#login-email', user.email);
    await page.fill('#login-password', 'WrongPassword1!');
    await page.click('button[type="submit"]');

    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });
    expect(await page.evaluate(() => localStorage.getItem('strawberry.token'))).toBeNull();
  });

  test('an authenticated route redirects to login when logged out', async ({ page }) => {
    await page.goto('/#/orders');
    await page.waitForFunction(() => location.hash.startsWith('#/login'), { timeout: 5000 });
  });

  test('account: changing the password logs out all sessions and requires the new one', async ({ page }) => {
    const user = await registerAndLoginUI(page, { prefix: 'pwchg' });
    const newPassword = 'NewSecret123!';

    await page.goto('/#/account');
    await page.waitForSelector('#acc-current');
    await page.fill('#acc-current', user.password);
    await page.fill('#acc-new', newPassword);
    await page.fill('#acc-confirm', newPassword);
    await page.click('button:has-text("パスワードを変更")');

    // Success revokes every session -> app clears local session and returns to login.
    await page.waitForFunction(() => location.hash === '#/login', { timeout: 5000 });
    expect(await page.evaluate(() => localStorage.getItem('strawberry.token'))).toBeNull();

    // The OLD password no longer works.
    await page.fill('#login-email', user.email);
    await page.fill('#login-password', user.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });

    // The NEW password logs in successfully.
    await page.fill('#login-email', user.email);
    await page.fill('#login-password', newPassword);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#/market', { timeout: 8000 });
  });

  test('account: a wrong current password surfaces an error and keeps the session', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'pwbad' });
    await page.goto('/#/account');
    await page.waitForSelector('#acc-current');
    await page.fill('#acc-current', 'TotallyWrong1!');
    await page.fill('#acc-new', 'AnotherSecret123!');
    await page.fill('#acc-confirm', 'AnotherSecret123!');
    await page.click('button:has-text("パスワードを変更")');

    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });
    // Still authenticated, still on the account page — no session loss on failure.
    expect(await page.evaluate(() => localStorage.getItem('strawberry.token'))).not.toBeNull();
    expect(page.url()).toContain('#/account');
  });
});
