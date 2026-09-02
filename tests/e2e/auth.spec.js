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

  // ── session lifecycle ─────────────────────────────────────────────────────
  // Both of these were silently broken before: the SPA discarded the refresh
  // token at login (so every session died after the 1h access-token TTL, in
  // the middle of a multi-hour rental) and "ログアウト" only cleared
  // localStorage (so a copied token stayed valid until it expired). The
  // server had the endpoints all along; nothing in public/ called them.

  test('logout invalidates the bearer token on the server, not just in localStorage', async ({ page, baseURL }) => {
    const { token } = await registerAndLoginUI(page, { prefix: 'revoke' });
    const refreshToken = await page.evaluate(() => localStorage.getItem('strawberry.refresh'));
    expect(refreshToken, 'login must persist the refresh token').toBeTruthy();

    // Sanity: the token works before logout.
    const before = await page.request.get(`${baseURL}/api/v1/users/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(before.status()).toBe(200);

    await page.click('button:has-text("ログアウト")');
    await page.waitForFunction(() => location.hash === '#/login', { timeout: 5000 });

    // The same token, replayed by "someone who copied it", is now dead.
    const after = await page.request.get(`${baseURL}/api/v1/users/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(after.status()).toBe(401);
    // And so is the refresh token: it can't mint a new session either.
    const refreshed = await page.request.post(`${baseURL}/api/v1/users/refresh`, { data: { refreshToken } });
    expect(refreshed.status()).toBe(401);
    expect(await page.evaluate(() => localStorage.getItem('strawberry.refresh'))).toBeNull();
  });

  test('a rejected access token is refreshed transparently instead of kicking the user to login', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const { token } = await registerAndLoginUI(page, { prefix: 'refresh' });

    // Simulate the hourly expiry: corrupt the signature so the server answers
    // 401 exactly as it does for an expired token. The refresh token stays.
    await page.evaluate((t) => localStorage.setItem('strawberry.token', t.slice(0, -4) + 'dead'), token);
    await page.goto('/#/orders');

    // Authenticated page renders; no bounce to #/login.
    await expect(page.locator('h1, h2').first()).toBeVisible();
    await page.waitForFunction(() => location.hash === '#/orders', { timeout: 5000 });
    // And the stored token has been replaced by a fresh, valid one.
    const now = await page.evaluate(() => localStorage.getItem('strawberry.token'));
    expect(now).not.toBe(token);
    expect(now.endsWith('dead')).toBe(false);
    // Chrome logs the deliberate 401s as resource-load errors; anything else
    // (a thrown ApiError, a render crash) is a real failure.
    const unexpected = consoleErrors.filter((e) => !/status of 401/.test(e));
    expect(unexpected, `Unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);
  });
});
