// tests/e2e/access-delivery.spec.js
// プロダクトが売っているもの（＝GPUに接続できること）が、実ブラウザで実際に届くか。
//
// これが通るまで、Strawberry は「支払えるが借りられない」プロダクトだった。
const { test, expect } = require('@playwright/test');
const { apiRegisterAndLogin, apiCreateGpu, promoteToAdmin, loginUI, uniqueId } = require('./helpers');

async function rentUpToActive(request, baseURL) {
  const provider = await apiRegisterAndLogin(request, baseURL, { prefix: 'delprov', role: 'provider' });
  const gpu = await apiCreateGpu(request, baseURL, provider.token, { name: `Delivery GPU ${uniqueId()}`, pricePerHour: 1000 });
  const renter = await apiRegisterAndLogin(request, baseURL, { prefix: 'delrent' });

  const { orderId } = await (await request.post(`${baseURL}/api/v1/orders`, {
    headers: { Authorization: `Bearer ${renter.token}` },
    data: { gpuId: gpu.id, durationMinutes: 60 },
  })).json();
  await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, { headers: { Authorization: `Bearer ${provider.token}` } });
  const { paymentId } = await (await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
    headers: { Authorization: `Bearer ${renter.token}` },
    data: { paymentMethod: 'bank_transfer' },
  })).json();
  const admin = await apiRegisterAndLogin(request, baseURL, { prefix: `dadm${uniqueId()}`.slice(0, 12) });
  const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
  await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  await request.post(`${baseURL}/api/v1/orders/${orderId}/start`, { headers: { Authorization: `Bearer ${renter.token}` } });
  return { provider, renter, orderId };
}

test.describe('GPU access delivery (the core product loop)', () => {
  test('provider hands over connection details and the renter sees them', async ({ page, request, baseURL }) => {
    const { provider, renter, orderId } = await rentUpToActive(request, baseURL);

    // 借り手は、まだ届いていないことを正直に知らされる
    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.access-card')).toContainText('まだ接続情報を登録していません', { timeout: 8000 });

    // プロバイダが接続情報を投入する
    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    const card = page.locator('.access-card');
    await expect(card).toContainText('接続手段を用意できるのはあなただけです');
    await card.locator('input[type="text"]').first().fill('gpu-e2e.example.com:2222');
    await card.locator('input[type="text"]').nth(1).fill('rentuser');
    await card.locator('textarea').first().fill('E2E-SECRET-KEY');
    await card.locator('button:has-text("接続情報を借り手に渡す")').click();
    await expect(card).toContainText('登録済み', { timeout: 8000 });

    // 借り手の画面に実際の接続先と認証情報が出る
    await loginUI(page, renter.email, renter.password);
    await page.goto(`/#/orders/${orderId}`);
    const renterCard = page.locator('.access-card');
    await expect(renterCard).toContainText('gpu-e2e.example.com:2222', { timeout: 8000 });
    await expect(renterCard).toContainText('rentuser');
    await expect(renterCard.locator('.access-credential')).toHaveValue('E2E-SECRET-KEY');
  });

  test('the provider never gets the credential read back, only the summary', async ({ page, request, baseURL }) => {
    const { provider, orderId } = await rentUpToActive(request, baseURL);
    await request.post(`${baseURL}/api/v1/orders/${orderId}/access`, {
      headers: { Authorization: `Bearer ${provider.token}` },
      data: { method: 'ssh', endpoint: 'p.example.com:22', credential: 'PROVIDER-ONLY-SECRET' },
    });

    await loginUI(page, provider.email, provider.password);
    await page.goto(`/#/orders/${orderId}`);
    await expect(page.locator('.access-card')).toContainText('登録済み', { timeout: 8000 });
    // 画面のどこにも平文の認証情報は出ない
    await expect(page.locator('body')).not.toContainText('PROVIDER-ONLY-SECRET');
  });
});
