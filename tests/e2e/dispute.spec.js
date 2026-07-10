// tests/e2e/dispute.spec.js — raising a dispute on an active order and the
// admin resolution panel (refund vs. uphold), including the confirm-before-
// resolve safety gate (this moves real funds/reputation, per the backend's
// own comments on POST /:id/dispute/resolve).
const { test, expect } = require('@playwright/test');
const { loginUI, apiRegisterAndLogin, apiCreateGpu, promoteToAdmin, uniqueId, trackConsoleErrors } = require('./helpers');

async function setUpActiveOrder(request, baseURL, prefix) {
  const provider = await apiRegisterAndLogin(request, baseURL, { prefix: `${prefix}prov`, role: 'provider' });
  const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Dispute GPU ${uniqueId()}` });
  const renter = await apiRegisterAndLogin(request, baseURL, { prefix: `${prefix}rent` });
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
  const admin = await apiRegisterAndLogin(request, baseURL, { prefix: `${prefix}admin` });
  const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
  await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  await request.post(`${baseURL}/api/v1/orders/${orderId}/start`, { headers: { Authorization: `Bearer ${renter.token}` } });
  return { provider, renter, admin, adminToken, orderId };
}

test.describe('dispute', () => {
  test('renter raises a dispute; admin sees it and resolves as refund', async ({ page, request, baseURL }) => {
    const consoleErrors = trackConsoleErrors(page);
    const { renter, admin, orderId } = await setUpActiveOrder(request, baseURL, `disp1${uniqueId()}`.slice(0, 10));

    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.badge-active')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("係争を申請する")');
    await page.fill('textarea', 'GPU did not perform as advertised');
    await page.click('button:has-text("申請を送信")');
    await expect(page.locator('.badge-disputed')).toBeVisible({ timeout: 5000 });
    // Exact "申請者: 借り手" text -- a bare "借り手" substring locator is
    // ambiguous once the admin resolve panel is present, since its refund
    // button label ("返金（借り手勝訴）") also contains the substring.
    await expect(page.locator('text=申請者: 借り手')).toBeVisible();

    await page.evaluate(() => localStorage.clear());
    await loginUI(page, admin.email, admin.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('text=管理者裁定')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("返金（借り手勝訴）")');
    await page.fill('textarea', 'Verified provider fault');
    await page.click('button:has-text("裁定を確定")');
    await page.waitForSelector('.modal', { timeout: 3000 });
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('.badge-cancelled')).toBeVisible({ timeout: 5000 });

    const finalOrder = await request.get(`${baseURL}/api/v1/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    }).then((r) => r.json());
    expect(finalOrder.order.status).toBe('cancelled');
    expect(finalOrder.order.dispute.resolution.decision).toBe('refund');
    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('admin resolves as uphold; order completes instead of cancelling', async ({ page, request, baseURL }) => {
    const { provider, renter, admin, orderId } = await setUpActiveOrder(request, baseURL, `disp2${uniqueId()}`.slice(0, 10));

    await request.post(`${baseURL}/api/v1/orders/${orderId}/dispute`, {
      headers: { Authorization: `Bearer ${provider.token}` },
      data: { reason: 'Renter abused the session' },
    });

    await loginUI(page, admin.email, admin.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('text=申請者: プロバイダー')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("棄却（プロバイダー勝訴）")');
    await page.click('button:has-text("裁定を確定")');
    await page.waitForSelector('.modal', { timeout: 3000 });
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('.badge-completed')).toBeVisible({ timeout: 5000 });
  });

  test('non-admin viewing a disputed order sees no resolve panel', async ({ page, request, baseURL }) => {
    const { renter, orderId } = await setUpActiveOrder(request, baseURL, `disp3${uniqueId()}`.slice(0, 10));
    await request.post(`${baseURL}/api/v1/orders/${orderId}/dispute`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { reason: 'test' },
    });
    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.badge-disputed')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=管理者裁定')).toHaveCount(0);
  });
});
