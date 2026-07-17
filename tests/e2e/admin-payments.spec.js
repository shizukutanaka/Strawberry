// tests/e2e/admin-payments.spec.js — the approval queue for manual (bank
// transfer) payments, and its access control (route-gated to admin both at
// the nav-visibility layer and the direct-navigation layer).
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, loginUI, apiRegisterAndLogin, apiCreateGpu, promoteToAdmin, uniqueId, trackConsoleErrors } = require('./helpers');

test.describe('admin payments', () => {
  test('admin approves a pending payment; it disappears from the queue and confirms server-side', async ({ page, request, baseURL }) => {
    const consoleErrors = trackConsoleErrors(page);
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'apprv', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Approve GPU ${uniqueId()}`, pricePerHour: 900 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'apprvrent' });
    const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { gpuId: gpu.id, durationMinutes: 60 },
    });
    const { orderId } = await orderRes.json();
    await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, { headers: { Authorization: `Bearer ${provider.token}` } });
    const payRes = await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { paymentMethod: 'bank_transfer' },
    });
    const { paymentId } = await payRes.json();

    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'apprvadmin' });
    await promoteToAdmin(request, baseURL, admin.email, admin.password);

    await loginUI(page, admin.email, admin.password);
    await page.goto('/#/admin/payments');
    await page.waitForSelector('table.data-table', { timeout: 5000 });
    await expect(page.locator('table.data-table')).toContainText('900 sats');
    await expect(page.locator('table.data-table')).toContainText(renter.username);

    await page.click('.js-approve');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('.empty-state')).toBeVisible({ timeout: 5000 });

    const statusCheck = await request.get(`${baseURL}/api/v1/payments/${paymentId}/status`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    }).then((r) => r.json());
    expect(statusCheck.status).toBe('paid');
    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('non-admin cannot see the nav link or access the route', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'noadmin' });
    await expect(page.locator('#nav a[href="#/admin/payments"]')).toHaveCount(0);

    await page.goto('/#/admin/payments');
    await expect(page.locator('text=アクセス権限がありません')).toBeVisible({ timeout: 5000 });
  });

  test('cancelling the confirm dialog does not approve the payment', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'cancelappr', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Cancel GPU ${uniqueId()}` });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'cancelrent' });
    const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { gpuId: gpu.id, durationMinutes: 30 },
    });
    const { orderId } = await orderRes.json();
    await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, { headers: { Authorization: `Bearer ${provider.token}` } });
    await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { paymentMethod: 'bank_transfer' },
    });

    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'cancelnadmin' });
    await promoteToAdmin(request, baseURL, admin.email, admin.password);
    await loginUI(page, admin.email, admin.password);
    await page.goto('/#/admin/payments');
    await page.waitForSelector('table.data-table', { timeout: 5000 });
    await page.click('.js-approve');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("キャンセル")');
    // Row still present, not removed.
    await expect(page.locator('table.data-table tbody tr')).toHaveCount(1);
  });
});
