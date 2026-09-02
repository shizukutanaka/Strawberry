// tests/e2e/account.spec.js — the account page: password change, notification
// channels, and the list of GPUs being watched for a price drop.
//
// All three server capabilities pre-dated this page; none had a screen. The
// notification channels matter most: they are the only route by which a
// provider hears "you have an order", so without this page no provider was
// ever notified.
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, loginUI, apiRegisterAndLogin, apiCreateGpu, uniqueId, trackConsoleErrors } = require('./helpers');

test.describe('account page', () => {
  test('password change invalidates the session and the new password is the one that works', async ({ page }) => {
    const consoleErrors = trackConsoleErrors(page);
    const user = await registerAndLoginUI(page, { prefix: 'acctpw' });
    await page.click('#nav a[href="#/account"]');
    await page.waitForSelector('#pw-current');
    await page.fill('#pw-current', user.password);
    await page.fill('#pw-new', 'Changed5678!');
    await page.fill('#pw-confirm', 'Changed5678!');
    await page.click('button:has-text("パスワードを変更")');
    // The server revokes every existing session on a password change, so the
    // page must send the user back to login rather than pretend to continue.
    await page.waitForFunction(() => location.hash.startsWith('#/login'), { timeout: 5000 });
    expect(await page.evaluate(() => localStorage.getItem('strawberry.token'))).toBeNull();

    // Old password: rejected. New password: accepted.
    await page.goto('/#/login');
    await page.waitForSelector('#login-email');
    await page.fill('#login-email', user.email);
    await page.fill('#login-password', user.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('.error-msg')).toBeVisible({ timeout: 5000 });
    await loginUI(page, user.email, 'Changed5678!');
    await expect(page.locator('#nav a[href="#/orders"]')).toBeVisible();
    // A failed login logs a 401 resource error in Chrome; nothing else may.
    const unexpected = consoleErrors.filter((e) => !/status of 401/.test(e));
    expect(unexpected, `Unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);
  });

  test('notification channels round-trip, keep a masked LINE token, and can be deleted', async ({ page, request, baseURL }) => {
    const user = await registerAndLoginUI(page, { prefix: 'acctnt' });
    const me = await request.get(`${baseURL}/api/v1/users/me`, { headers: { Authorization: `Bearer ${user.token}` } }).then((r) => r.json());
    const userId = me.id || (me.user && me.user.id);

    await page.goto('/#/account');
    await page.waitForSelector('#notify-discordWebhook');
    await page.fill('#notify-discordWebhook', 'https://discord.com/api/webhooks/1234567890/abcdefg');
    await page.fill('#notify-email', 'me@example.com');
    await page.fill('#notify-lineToken', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    await page.click('button:has-text("通知先を保存")');
    await expect(page.locator('.toast, .toast-success').first()).toContainText('保存', { timeout: 5000 });

    // Reload: the values are what the server holds, and the token is masked.
    await page.reload();
    await page.waitForSelector('#notify-discordWebhook');
    await expect(page.locator('#notify-discordWebhook')).toHaveValue('https://discord.com/api/webhooks/1234567890/abcdefg');
    await expect(page.locator('#notify-email')).toHaveValue('me@example.com');
    await expect(page.locator('#notify-lineToken')).toHaveValue('***');

    // Saving again with the masked token must not wipe the real one.
    await page.fill('#notify-email', 'other@example.com');
    await page.click('button:has-text("通知先を保存")');
    await expect(page.locator('#notify-email')).toHaveValue('other@example.com', { timeout: 5000 });
    const stored = await request.get(`${baseURL}/api/v1/notification-settings/${userId}`, {
      headers: { Authorization: `Bearer ${user.token}` },
    }).then((r) => r.json());
    expect(stored.email).toBe('other@example.com');
    expect(stored.lineToken).toBe('***'); // still set (masked), not deleted

    await page.click('button:has-text("通知先をすべて削除")');
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('#notify-discordWebhook')).toHaveValue('', { timeout: 5000 });
    const gone = await request.get(`${baseURL}/api/v1/notification-settings/${userId}`, {
      headers: { Authorization: `Bearer ${user.token}` },
    }).then((r) => r.json());
    expect(gone.discordWebhook).toBeUndefined();
  });

  test('lists the GPUs being watched and can stop watching from the list', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'acctwp', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Watched GPU ${uniqueId()}`, pricePerHour: 900 });
    const renter = await registerAndLoginUI(page, { prefix: 'acctwr' });
    await request.post(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { targetPrice: 700 },
    });

    await page.goto('/#/account');
    const row = page.locator('.watch-row');
    await expect(row).toContainText(gpu.name, { timeout: 5000 });
    await expect(row).toContainText('700');
    await row.locator('button:has-text("解除")').click();
    await expect(page.locator('.watch-row')).toHaveCount(0, { timeout: 5000 });
    const check = await request.get(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    });
    expect(check.status()).toBe(404);
  });
});
