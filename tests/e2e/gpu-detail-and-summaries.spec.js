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
    // The page has several `.card` elements (specs, performance score, watch
    // section, review). `.spec-card` is the specs card's own hook -- `.card.stack`
    // is not unique any more now that the performance-score card uses it too.
    await expect(page.locator('.spec-card')).toContainText('48 GB');
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
    await expect(page.locator('.spec-card')).toContainText('スペック: 自己申告');

    await page.goto(`/#/gpus/${verified.id}`);
    await expect(page.locator('.spec-card')).toContainText('スペック: 実測検証済み');
  });

  test('shows a market-rate line only when 2+ listings share the same model', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'ratesprov', role: 'provider' });
    const uniqueModel = `RTX-RATE-${uniqueId()}`;
    const soloGpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Solo GPU ${uniqueId()}`, model: `${uniqueModel}-SOLO`, pricePerHour: 900 });
    const peerA = await apiCreateGpu(request, baseURL, provider.token, { name: `Peer A ${uniqueId()}`, model: uniqueModel, pricePerHour: 1000 });
    const _peerB = await apiCreateGpu(request, baseURL, provider.token, { name: `Peer B ${uniqueId()}`, model: uniqueModel, pricePerHour: 2000 });

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
    await page.waitForSelector('button:has-text("通知を設定")', { timeout: 5000 });
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
});

test.describe('normalized performance score', () => {
  test('shows the score, its basis, and the price-performance chip for a known GPU', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'perfprov', role: 'provider' });
    // helper の既定は RTX 4090 24GB = 参照GPU そのもの → スコアはちょうど 100
    const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Perf GPU ${uniqueId()}`, pricePerHour: 1000 });

    await page.goto(`/#/gpus/${gpu.id}`);
    const perfCard = page.locator('.perf-card');
    await expect(perfCard).toContainText('性能 100');
    // 裏付けの強さを必ず区別して見せる（実機検証はしていないので「型番既知」）
    await expect(perfCard).toContainText('型番既知');
    await expect(perfCard).toContainText('照合された型番');
    // 価格対性能 100/1000 = 0.1
    await expect(perfCard).toContainText('コスパ 0.100/sat');
  });

  test('withholds the score and warns when the declared model contradicts the VRAM', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'perffraud', role: 'provider' });
    // 「H100」を名乗る 24GB の出品 — H100 のスコアが付いてはならない
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `Fraud GPU ${uniqueId()}`, model: 'H100', memoryGB: 24, pricePerHour: 9000,
    });

    await page.goto(`/#/gpus/${gpu.id}`);
    const perfCard = page.locator('.perf-card');
    await expect(perfCard).toContainText('性能: 未算出');
    await expect(perfCard).toContainText('申告スペックに関する注意');
    await expect(perfCard).toContainText('vram_mismatch');
  });

  test('market list carries the perf badge and offers the price-performance sort', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'perfmkt', role: 'provider' });
    const name = `MktPerf GPU ${uniqueId()}`;
    await apiCreateGpu(request, baseURL, provider.token, { name, pricePerHour: 1000 });

    await page.goto('/#/market');
    await page.locator('input[type="search"]').fill(name);
    await page.locator('button:has-text("絞り込み")').click();
    const card = page.locator('.gpu-card').filter({ hasText: name });
    await expect(card).toContainText('性能 100');
    await expect(card).toContainText('コスパ');

    // 並び順に「コスパが良い順」が出ていて、選んでも一覧が壊れない
    await page.locator('select').nth(1).selectOption('value');
    await expect(page.locator('.gpu-card').first()).toBeVisible();
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
