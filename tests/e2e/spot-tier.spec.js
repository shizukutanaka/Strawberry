// tests/e2e/spot-tier.spec.js — Spot（中断許容）ティアを実ブラウザで通す。
//
// 検証の主眼は「割引と中断リスクが同じ重みで提示されているか」。安さだけ見せて
// 中断条件を隠すと、借り手は不利な取引に誘導される。バッジ・警告・猶予秒数・
// 中断率の開示が実際に画面に出ることを確認する。
const { test, expect } = require('@playwright/test');
const { apiRegisterAndLogin, apiCreateGpu, loginUI, uniqueId } = require('./helpers');

test.describe('spot (interruptible) tier', () => {
  test('market and detail pages advertise the spot discount', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'spotmkt', role: 'provider' });
    const name = `Spot GPU ${uniqueId()}`;
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name, pricePerHour: 1000, spotEnabled: true, spotDiscountPct: 60, spotNoticeSeconds: 90,
    });

    await page.goto('/#/market');
    await page.fill('input[type="search"]', name);
    await page.click('button:has-text("絞り込み")');
    const card = page.locator('.gpu-card').filter({ hasText: name });
    await expect(card).toContainText('中断許容 -60%');

    await page.goto(`/#/gpus/${gpu.id}`);
    await expect(page.locator('.chip-spot')).toContainText('中断許容 -60%');
  });

  test('the rent modal shows the discounted estimate and the interruption terms together', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'spotprov', role: 'provider' });
    const name = `Spot Rent GPU ${uniqueId()}`;
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name, pricePerHour: 1000, spotEnabled: true, spotDiscountPct: 50, spotNoticeSeconds: 60,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'spotrent' });
    await loginUI(page, renter.email, renter.password);

    await page.goto(`/#/gpus/${gpu.id}`);
    await page.click('button:has-text("このGPUを借りる")');

    // 既定は専有。1時間ぶんの定価が出る。
    const modal = page.locator('.modal');
    await expect(modal).toContainText('1,000 sats');
    await expect(modal.locator('.banner-warning')).toBeHidden();

    // 中断許容へ切り替えると価格が半分になり、同時に中断条件が現れる。
    await modal.locator('[data-testid="tier-picker"] button', { hasText: '中断許容' }).click();
    await expect(modal).toContainText('500 sats');
    const warning = modal.locator('.banner-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('60 秒');
    await expect(warning).toContainText('実際に提供された時間分のみ');
    // 実績が無いことを「0%」と偽らず、正直に「蓄積されていない」と書く
    await expect(warning).toContainText('十分に蓄積されていません');
  });

  test('provider preempts a spot order; renter sees the countdown and settles pro-rata', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'spotpre', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `Preempt GPU ${uniqueId()}`, pricePerHour: 1000,
      spotEnabled: true, spotDiscountPct: 50, spotNoticeSeconds: 300,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'sprenter' });

    // 注文を作り、承認 → 支払い → 開始まで進める
    const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { gpuId: gpu.id, durationMinutes: 60, tier: 'spot' },
    });
    const { orderId } = await orderRes.json();
    await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`,
      { headers: { Authorization: `Bearer ${provider.token}` } });
    const payRes = await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { paymentMethod: 'bank_transfer' },
    });
    const { paymentId } = await payRes.json();
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: `spadm${uniqueId()}`.slice(0, 12) });
    const { promoteToAdmin } = require('./helpers');
    const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
    await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } });
    await request.post(`${baseURL}/api/v1/orders/${orderId}/start`,
      { headers: { Authorization: `Bearer ${renter.token}` } });

    // プロバイダの画面には Spot 専用の中断ボタンが出る（専有注文には出ない）
    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    const preemptBtn = page.locator('button:has-text("この注文を中断する")');
    await expect(preemptBtn).toBeVisible();

    await preemptBtn.click();
    // confirmDialog はブラウザの confirm ではなく自前モーダル（public/js/ui.js）
    await page.locator('.modal button:has-text("実行")').click();
    await expect(page.locator('.badge-preempting')).toBeVisible({ timeout: 8000 });

    // 借り手の画面には猶予カウントダウンと「提供時間分のみ課金」の明示が出る
    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.banner-warning')).toContainText('実際に提供された時間分のみ');
    await expect(page.locator('.countdown')).toContainText('停止まで残り');

    // 借り手が保存を終えて自分で停止 → 完了扱いになる
    await page.click('button:has-text("今すぐ停止する")');
    await expect(page.locator('.badge-completed')).toBeVisible({ timeout: 8000 });

    // 中断終了として記録されている（中断率の分子になる）
    const finalOrder = await (await request.get(`${baseURL}/api/v1/orders/${orderId}`,
      { headers: { Authorization: `Bearer ${renter.token}` } })).json();
    expect(finalOrder.order.terminationReason).toBe('preempted');
  });

  test('an on-demand order gives the provider no preempt button', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'nospotpr', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `OnDemand GPU ${uniqueId()}`, pricePerHour: 1000, spotEnabled: true, spotDiscountPct: 50,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'nospotrt' });
    const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${renter.token}` },
      data: { gpuId: gpu.id, durationMinutes: 60 }, // tier 未指定 = 専有
    });
    const { orderId } = await orderRes.json();
    await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`,
      { headers: { Authorization: `Bearer ${provider.token}` } });

    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('button:has-text("この注文を中断する")')).toHaveCount(0);
  });
});
