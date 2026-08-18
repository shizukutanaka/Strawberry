// tests/e2e/payout.spec.js — 貸し手が稼ぎを受け取るまでの通し確認。
//
// この経路が壊れていると、貸し手は GPU を貸して代金を回収できない。以前は
// 「収益」画面が注文の総額だけを表示し、受け取る手段は API にもコードにも
// 存在しなかった（借り手が払った sats は運営ノードに滞留したままだった）。
const { test, expect } = require('@playwright/test');
const {
  apiRegisterAndLogin, apiCreateGpu, apiCompleteOrderCycle, loginUI,
  promoteToAdmin, uniqueId, trackConsoleErrors,
} = require('./helpers');

test.describe('provider payout', () => {
  test('completed order → ledger credit → payout request → operator records the txid', async ({ page, request, baseURL }) => {
    const consoleErrors = trackConsoleErrors(page);

    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'poprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `Payout GPU ${uniqueId()}`, pricePerHour: 400000,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'porent' });

    // 受取アドレスを登録する。未登録だと出金申請は拒否される（本来そうあるべき）。
    await request.put(`${baseURL}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${provider.token}` },
      data: { payoutAddress: `lnbc-payout-${uniqueId()}` },
    });

    const { adminToken } = await apiCompleteOrderCycle(request, baseURL, {
      providerToken: provider.token, renterToken: renter.token, gpuId: gpu.id,
    });

    // 掃き出しジョブは既定 5 分間隔なので、テストでは即時実行して待たない。
    const sweep = await request.post(`${baseURL}/api/v1/payments/admin/earnings/sweep`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    }).then((r) => r.json());
    expect(sweep.credited).toBeGreaterThanOrEqual(1);

    // 貸し手の画面に受取可能残高が出ること。
    await loginUI(page, provider.email, provider.password);
    await page.goto('/#/earnings');
    const balanceCard = page.locator('.balance-card');
    await expect(balanceCard).toContainText('受取可能残高', { timeout: 5000 });
    const balanceText = await page.locator('.balance-amount').innerText();
    const balanceSats = Number(balanceText.replace(/[^0-9]/g, ''));
    // 手数料が引かれているので、注文総額そのままではない。
    expect(balanceSats).toBeGreaterThan(0);
    expect(balanceSats).toBeLessThan(400000);

    // 台帳明細に売上計上が載ること。
    await expect(page.locator('.ledger-table')).toContainText('売上計上');

    // 出金申請。
    await page.click('.btn-payout');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('.balance-card')).toContainText('送金待ち', { timeout: 5000 });
    await expect(page.locator('.balance-amount')).toHaveText('0 sats');

    // 運営が送金し、取引 ID を記録する。
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'poadmin' });
    await promoteToAdmin(request, baseURL, admin.email, admin.password);
    await page.evaluate(() => localStorage.clear());
    await loginUI(page, admin.email, admin.password);
    await page.goto('/#/admin/payments');

    const payoutRow = page.locator('.payout-table tbody tr', { hasText: provider.username });
    await expect(payoutRow).toBeVisible({ timeout: 5000 });

    // 取引 ID 未入力では送金済みにできない（台帳と現実が食い違うのを防ぐ）。
    await payoutRow.locator('.js-settle').click();
    await expect(page.locator('.toast-error')).toContainText('取引 ID', { timeout: 5000 });

    await payoutRow.locator('.js-txid').fill(`txid-${uniqueId()}`);
    await payoutRow.locator('.js-settle').click();
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("実行")');
    // このプロバイダの行だけが消えていること。キューが空になることは仮定しない
    // （データが持ち越される E2E 環境では、他のテストの申請が残っていてよい）。
    await expect(payoutRow).toHaveCount(0, { timeout: 5000 });

    // 貸し手側では「送金済み」へ移り、残高は 0 のまま（二重に受け取れない）。
    await page.evaluate(() => localStorage.clear());
    await loginUI(page, provider.email, provider.password);
    await page.goto('/#/earnings');
    await expect(page.locator('.balance-card')).toContainText('送金済み', { timeout: 5000 });
    await expect(page.locator('.ledger-table')).toContainText('送金済み');
    await expect(page.locator('.balance-amount')).toHaveText('0 sats');

    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('a user with no payout address is told so instead of failing silently', async ({ page, request, baseURL }) => {
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'noaddr', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `NoAddr GPU ${uniqueId()}`, pricePerHour: 300000,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'noaddrrent' });
    const { adminToken } = await apiCompleteOrderCycle(request, baseURL, {
      providerToken: provider.token, renterToken: renter.token, gpuId: gpu.id,
    });
    await request.post(`${baseURL}/api/v1/payments/admin/earnings/sweep`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    await loginUI(page, provider.email, provider.password);
    await page.goto('/#/earnings');
    await expect(page.locator('.balance-card')).toContainText('受取可能残高', { timeout: 5000 });
    await page.click('.btn-payout');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("実行")');
    await expect(page.locator('.toast-error')).toContainText('受取アドレス', { timeout: 5000 });
  });

  test('a renter owed a refund can see and claim it (the ledger is not provider-only)', async ({ page, request, baseURL }) => {
    // 未提供分は借り手の残高として計上される。以前は #/earnings が provider/admin
    // ロールで閉じていたため、返金を受け取れる借り手がその存在すら見られなかった
    // （＝誰にも見えない金になる）。
    const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'refprov', role: 'provider' });
    const gpu = await apiCreateGpu(request, baseURL, provider.token, {
      name: `Refund GPU ${uniqueId()}`, pricePerHour: 400000,
      spotEnabled: true, spotDiscountPct: 50, spotNoticeSeconds: 300,
    });
    const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'refrent' });

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
    const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'refadmin' });
    const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
    await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } });
    await request.post(`${baseURL}/api/v1/orders/${orderId}/start`,
      { headers: { Authorization: `Bearer ${renter.token}` } });

    // プロバイダ都合の中断 → 実提供分だけ課金され、残りは借り手への返金になる
    await request.post(`${baseURL}/api/v1/orders/${orderId}/preempt`,
      { headers: { Authorization: `Bearer ${provider.token}` } });
    await request.post(`${baseURL}/api/v1/orders/${orderId}/stop`,
      { headers: { Authorization: `Bearer ${renter.token}` } });
    const sweep = await request.post(`${baseURL}/api/v1/payments/admin/earnings/sweep`,
      { headers: { Authorization: `Bearer ${adminToken}` } }).then((r) => r.json());
    expect(sweep.credited).toBeGreaterThanOrEqual(1);

    // 借り手としてログインすると、ナビに「残高」が出て開ける
    await loginUI(page, renter.email, renter.password);
    await expect(page.locator('#nav a[href="#/earnings"]')).toContainText('残高');
    await page.goto('/#/earnings');
    await expect(page.locator('.balance-card')).toContainText('受取可能残高', { timeout: 5000 });
    await expect(page.locator('.ledger-table')).toContainText('返金受取');

    // 貸し手向けの「注文総額の集計」は借り手には出さない（provider 専用 API のため）
    await expect(page.locator('.gpu-breakdown')).toHaveCount(0);

    // 返金額は支払い総額の一部であって全額ではない（提供時間分は課金されている）
    const balanceText = await page.locator('.balance-amount').innerText();
    const balanceSats = Number(balanceText.replace(/[^0-9]/g, ''));
    expect(balanceSats).toBeGreaterThan(0);
    expect(balanceSats).toBeLessThanOrEqual(400000);
  });
});
