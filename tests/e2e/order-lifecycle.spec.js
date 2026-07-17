// tests/e2e/order-lifecycle.spec.js — the core transaction the marketplace
// exists for: pending -> matched -> paid -> active -> completed -> reviewed,
// driven through the real order-detail state machine in the UI (not just the
// API), across two accounts (renter + provider) switching sessions mid-flow.
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, loginUI, apiRegisterAndLogin, apiCreateGpu, uniqueId, trackConsoleErrors } = require('./helpers');

test.describe('order lifecycle', () => {
  test('full cycle via UI: create, accept, pay (bank transfer), start, heartbeat, stop, review', async ({ page, request, baseURL }) => {
    const consoleErrors = trackConsoleErrors(page);
    // Provider + GPU set up via API (faster; not what this test is verifying).
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'lcprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Lifecycle GPU ${uniqueId()}`, pricePerHour: 1200 });

    // Renter creates the order through the actual UI.
    const renter = await registerAndLoginUI(page, { prefix: 'lcrent' });
    await page.goto('/#/market');
    await page.fill('input[type="search"]', gpu.name);
    await page.click('button:has-text("絞り込み")');
    await page.waitForSelector('.gpu-card', { timeout: 5000 });
    await page.click('.gpu-card button:has-text("借りる")');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("1時間")');
    await page.click('.modal button:has-text("注文する")');
    await page.waitForFunction(() => /^#\/orders\//.test(location.hash), { timeout: 5000 });
    const orderId = page.url().match(/#\/orders\/([a-f0-9-]+)/)[1];
    await expect(page.locator('.badge-pending')).toBeVisible();

    // Provider accepts, through the UI, switching sessions.
    await page.evaluate(() => localStorage.clear());
    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    await page.click('button:has-text("承認する")');
    await expect(page.locator('.badge-matched')).toBeVisible({ timeout: 5000 });

    // Renter pays via bank transfer, then an admin approves out-of-band via
    // the API (the admin-payments UI itself is covered by its own spec).
    await page.evaluate(() => localStorage.clear());
    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    await page.click('button:has-text("銀行振込で支払う")');
    await expect(page.locator('.banner-warning')).toContainText('管理者の承認');

    const paymentInfo = await request.get(`${baseURL}/api/v1/orders/${orderId}/payment`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    }).then((r) => r.json());
    const pendingPayment = paymentInfo.payments.find((p) => p.status === 'pending');
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'lcadmin' });
    const fs = require('fs');
    const path = require('path');
    const usersPath = path.join(__dirname, '../../data/users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users[users.findIndex((u) => u.email === admin.email)].role = 'admin';
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    const adminLogin = await request.post(`${baseURL}/api/v1/users/login`, { data: { email: admin.email, password: admin.password } }).then((r) => r.json());
    await request.post(`${baseURL}/api/v1/payments/manual/approve/${pendingPayment.id}`, {
      headers: { Authorization: `Bearer ${adminLogin.token}` },
    });

    // Renter's UI poll picks up the approval without a manual reload.
    await expect(page.locator('button:has-text("利用を開始する")')).toBeVisible({ timeout: 15000 });
    await page.click('button:has-text("利用を開始する")');
    await expect(page.locator('.badge-active')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=ハートビート')).toBeVisible({ timeout: 3000 });

    await page.click('button:has-text("利用を停止する")');
    await expect(page.locator('.badge-completed')).toBeVisible({ timeout: 5000 });

    // Review.
    const stars = await page.$$('.rating-input button');
    await stars[4].click(); // 5 stars
    await page.fill('textarea', 'E2E test review');
    await page.click('button:has-text("レビューを送信")');
    await expect(page.locator('.stars')).toContainText('★★★★★', { timeout: 5000 });

    // Server-side confirmation, not just the optimistic UI re-render.
    const finalOrder = await request.get(`${baseURL}/api/v1/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    }).then((r) => r.json());
    expect(finalOrder.order.status).toBe('completed');
    expect(finalOrder.order.review.rating).toBe(5);
    expect(finalOrder.order.totalPrice).toBe(1200); // 60min @ 1200 sats/hr, price-locked at creation
    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('provider cannot stop an active order (must dispute instead)', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'nostop', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `NoStop GPU ${uniqueId()}` });
    // Driven manually rather than via apiCompleteOrderCycle (which also
    // stops the order) since this test needs the order to stay 'active'.
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'nostoprent' });
    const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { gpuId: gpu.id, durationMinutes: 30 },
    });
    const { orderId } = await orderRes.json();
    await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, { headers: { Authorization: `Bearer ${provider.token}` } });
    const payRes = await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { paymentMethod: 'bank_transfer' },
    });
    const { paymentId } = await payRes.json();
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'nostopadmin' });
    const fs = require('fs');
    const path = require('path');
    const usersPath = path.join(__dirname, '../../data/users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users[users.findIndex((u) => u.email === admin.email)].role = 'admin';
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    const adminLogin = await request.post(`${baseURL}/api/v1/users/login`, { data: { email: admin.email, password: admin.password } }).then((r) => r.json());
    await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`, { headers: { Authorization: `Bearer ${adminLogin.token}` } });
    await request.post(`${baseURL}/api/v1/orders/${orderId}/start`, { headers: { Authorization: `Bearer ${renter.token}` } });

    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.badge-active')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("利用を停止する")')).toHaveCount(0);
    await expect(page.locator('text=プロバイダーは利用を停止できません')).toBeVisible();
  });
});
