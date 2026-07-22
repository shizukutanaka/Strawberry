// tests/e2e/gpu-detail-and-summaries.spec.js — GPU detail page (specs +
// reviews), the price-watch toggle, provider earnings, and the orders-list
// stats header. Grouped together as smaller, related features rather than
// one file per page.
const { test, expect } = require('@playwright/test');
const { loginUI, apiRegisterAndLogin, apiCreateGpu, promoteToAdmin, uniqueId } = require('./helpers');

async function completeOneOrder(request, baseURL, { providerToken, providerEmail, providerPassword, renterToken, renterEmail, renterPassword, gpuId, pricePerHour }) {
  const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
    headers: { Authorization: `Bearer ${renterToken}` },
    data: { gpuId, durationMinutes: 60 },
  });
  const { orderId } = await orderRes.json();
  await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, { headers: { Authorization: `Bearer ${providerToken}` } });
  const payRes = await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
    headers: { Authorization: `Bearer ${renterToken}` },
    data: { paymentMethod: 'bank_transfer' },
  });
  const { paymentId } = await payRes.json();
  const admin = await apiRegisterAndLogin(request, baseURL, { prefix: `sumadmin${uniqueId()}`.slice(0, 12) });
  const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
  await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  await request.post(`${baseURL}/api/v1/orders/${orderId}/start`, { headers: { Authorization: `Bearer ${renterToken}` } });
  await request.post(`${baseURL}/api/v1/orders/${orderId}/stop`, { headers: { Authorization: `Bearer ${renterToken}` } });
  return orderId;
}

test.describe('GPU detail page', () => {
  test('shows full specs and a review after one is submitted', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'detprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Detail GPU ${uniqueId()}`, memoryGB: 48, pricePerHour: 1100 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'detrent' });
    const orderId = await completeOneOrder(request, baseURL, { providerToken: provider.token, renterToken: renter.token, gpuId: gpu.id });
    await request.post(`${baseURL}/api/v1/orders/${orderId}/review`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { rating: 4, comment: 'Solid performance' },
    });

    await page.goto(`/#/gpus/${gpu.id}`);
    await expect(page.locator('h1')).toContainText(gpu.name);
    // The page has three `.card` elements (specs, watch section, review) --
    // `.card.stack` (compound class selector) is unique to the specs card.
    await expect(page.locator('.card.stack')).toContainText('48 GB');
    await expect(page.locator('text=Solid performance')).toBeVisible();
    await expect(page.locator('.stars').first()).toContainText('★★★★☆');
  });

  test('shows a self-reported badge with no attestation, and a verified badge with a matching one', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'attprov', role: 'provider' });
    const selfReported = await apiCreateGpu(request, baseURL, provider.token, { name: `Unverified GPU ${uniqueId()}` });
    const verified = await apiCreateGpu(request, baseURL, provider.token, {
      name: `Verified GPU ${uniqueId()}`,
      attestationReport: {
        model: 'RTX 4090',
        vendor: 'NVIDIA',
        memoryGB: 24,
        firmwareIntegrity: true,
        certChain: ['dGVzdC1jZXJ0'],
        timestamp: new Date().toISOString(),
        signature: 'e2e-test-signature-1234',
        measurements: { tempC: 65, powerW: 400, utilizationPct: 50 },
      },
    });

    await page.goto(`/#/gpus/${selfReported.id}`);
    await expect(page.locator('.card.stack')).toContainText('スペック: 自己申告');

    await page.goto(`/#/gpus/${verified.id}`);
    await expect(page.locator('.card.stack')).toContainText('スペック: 実測検証済み');
  });

  test('shows a market-rate line only when 2+ listings share the same model', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'ratesprov', role: 'provider' });
    const uniqueModel = `RTX-RATE-${uniqueId()}`;
    const soloGpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Solo GPU ${uniqueId()}`, model: `${uniqueModel}-SOLO`, pricePerHour: 900 });
    const peerA = await apiCreateGpu(request, baseURL, provider.token, { name: `Peer A ${uniqueId()}`, model: uniqueModel, pricePerHour: 1000 });
    const peerB = await apiCreateGpu(request, baseURL, provider.token, { name: `Peer B ${uniqueId()}`, model: uniqueModel, pricePerHour: 2000 });

    await page.goto(`/#/gpus/${soloGpu.id}`);
    await expect(page.locator('text=相場（同機種')).toHaveCount(0);

    await page.goto(`/#/gpus/${peerA.id}`);
    await expect(page.locator('text=相場（同機種 2件）')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=中央値 1,500 sats/時')).toBeVisible();
  });

  test('price-watch: set, confirm server-side, remove, confirm removed', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'watchprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Watch GPU ${uniqueId()}`, pricePerHour: 1000 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'watchrent' });

    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/gpus/${gpu.id}`);
    // 10s (not 5s): the detail page fans out GPU + reviews + rate + market-rate
    // fetches before the watch form renders; under a full-file run's shared-server
    // load the tighter timeout flaked intermittently (passes in isolation).
    await page.waitForSelector('button:has-text("通知を設定")', { timeout: 10000 });
    await page.fill('input[type="number"][step]', '700');
    await page.click('button:has-text("通知を設定")');
    await expect(page.locator('text=700 sats')).toBeVisible({ timeout: 5000 });

    const watchCheck = await request.get(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    }).then((r) => r.json());
    expect(watchCheck.watch.targetPrice).toBe(700);

    await page.click('button:has-text("通知を解除")');
    await expect(page.locator('button:has-text("通知を設定")')).toBeVisible({ timeout: 5000 });
    const removedCheck = await request.get(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    });
    expect(removedCheck.status()).toBe(404);
  });

  test('unauthenticated viewer sees a login prompt instead of the watch form', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'anonwatch', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Anon GPU ${uniqueId()}` });
    await page.goto(`/#/gpus/${gpu.id}`);
    await expect(page.locator('text=ログインすると値下げ通知')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("通知を設定")')).toHaveCount(0);
  });

  test('the watches list page shows a set watch and removes it', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'wlprov', role: 'provider' });
    const gpuName = `Watchlist GPU ${uniqueId()}`;
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: gpuName, pricePerHour: 2000 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'wlrent' });
    // Seed a watch via the API, then confirm the new list page renders it.
    await request.post(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { targetPrice: 1500 },
    });

    await loginUI(page, renter.email, renter.password);
    await page.goto('/#/watches');
    await expect(page.locator('table.data-table')).toContainText(gpuName, { timeout: 5000 });
    await expect(page.locator('table.data-table')).toContainText('1,500 sats');
    // current price (2000) > target (1500) -> still monitoring
    await expect(page.locator('text=監視中')).toBeVisible();

    await page.click('button:has-text("解除")');
    await expect(page.locator('text=ウォッチはまだありません')).toBeVisible({ timeout: 5000 });
    // server-side confirmation
    const check = await request.get(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
    });
    expect(check.status()).toBe(404);
  });

  test('drop-achieved is shown when the current price is at or below target', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'wlprov2', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Cheap GPU ${uniqueId()}`, pricePerHour: 800 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'wlrent2' });
    await request.post(`${baseURL}/api/v1/gpus/${gpu.id}/watch`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { targetPrice: 1000 }, // target above current 800 -> achieved
    });
    await loginUI(page, renter.email, renter.password);
    await page.goto('/#/watches');
    await expect(page.locator('text=値下げ達成')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('provider earnings', () => {
  test('shows completed revenue and a per-GPU breakdown after a sale', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'earnprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Earn GPU ${uniqueId()}`, pricePerHour: 1300 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'earnrent' });
    await completeOneOrder(request, baseURL, { providerToken: provider.token, renterToken: renter.token, gpuId: gpu.id });

    await loginUI(page, provider.email, provider.password);
    await page.goto('/#/earnings');
    await expect(page.locator('.grid')).toContainText('1,300 sats', { timeout: 5000 });
    await expect(page.locator('table.data-table')).toContainText(gpu.name);
  });
});

test.describe('order stats on the orders list', () => {
  test('renter sees spend total; provider on the same order sees both cards', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'statprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Stat GPU ${uniqueId()}`, pricePerHour: 2400 });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'statrent' });
    await completeOneOrder(request, baseURL, { providerToken: provider.token, renterToken: renter.token, gpuId: gpu.id });

    await loginUI(page, renter.email, renter.password);
    await page.goto('/#/orders');
    await page.waitForSelector('.grid', { timeout: 5000 });
    await expect(page.locator('.grid')).toContainText('2,400 sats');
    await expect(page.locator('.grid')).toContainText('完了 1件');

    await page.evaluate(() => localStorage.clear());
    await loginUI(page, provider.email, provider.password);
    await page.goto('/#/orders');
    await page.waitForSelector('.grid', { timeout: 5000 });
    await expect(page.locator('.grid')).toContainText('プロバイダーとして');
    await expect(page.locator('.grid')).toContainText('収益合計');
  });
});
