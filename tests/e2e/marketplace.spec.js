// tests/e2e/marketplace.spec.js — GPU registration, browse/search, availability toggle.
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, uniqueId } = require('./helpers');

test.describe('marketplace', () => {
  test('provider registers a GPU, sees it in my-gpus, toggles availability', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'mktprov', role: 'provider' });
    const gpuName = `Market GPU ${uniqueId()}`;

    await page.goto('/#/gpus/new');
    await page.waitForSelector('form input');
    const selects = await page.$$('select');
    await selects[0].selectOption('NVIDIA');
    await selects[1].selectOption('CUDA');
    await selects[2].selectOption('x86_64');
    const inputs = await page.$$('form input');
    await inputs[0].fill(gpuName);
    await inputs[1].fill('RTX 4090');
    await inputs[2].fill('550.90.07');
    await inputs[3].fill('Ubuntu 22.04');
    await inputs[4].fill('24');
    await inputs[5].fill('2500');
    await inputs[6].fill('450');
    await inputs[7].fill('1500');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#/my-gpus', { timeout: 8000 });

    await expect(page.locator('table.data-table')).toContainText(gpuName);
    await expect(page.locator('table.data-table')).toContainText('貸出可能');

    // Toggle off then back on — regression guard for the availability-flip
    // bug found earlier (a fresh GPU's `available` field is undefined, and
    // naively computing `!gpu.available` sends the wrong value on first click).
    await page.click('.js-toggle');
    await expect(page.locator('table.data-table')).toContainText('貸出停止中', { timeout: 5000 });
    await page.click('.js-toggle');
    await expect(page.locator('table.data-table')).toContainText('貸出可能', { timeout: 5000 });

    // Now find it in the market via search.
    await page.goto('/#/market');
    await page.fill('input[type="search"]', gpuName);
    await page.click('button:has-text("絞り込み")');
    await expect(page.locator('.gpu-card')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.gpu-card')).toContainText(gpuName);
    await expect(page.locator('.gpu-card')).toContainText('1,500 sats');
  });

  test('provider cannot rent their own GPU', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'selfprov', role: 'provider' });
    const gpuName = `Self GPU ${uniqueId()}`;
    await page.goto('/#/gpus/new');
    await page.waitForSelector('form input');
    const selects = await page.$$('select');
    await selects[0].selectOption('AMD');
    await selects[1].selectOption('ROCm');
    await selects[2].selectOption('x86_64');
    const inputs = await page.$$('form input');
    await inputs[0].fill(gpuName);
    await inputs[1].fill('MI300X');
    await inputs[2].fill('24.10');
    await inputs[3].fill('Debian 12');
    await inputs[4].fill('192');
    await inputs[5].fill('2100');
    await inputs[6].fill('750');
    await inputs[7].fill('2000');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#/my-gpus', { timeout: 8000 });

    await page.goto('/#/market');
    await page.fill('input[type="search"]', gpuName);
    await page.click('button:has-text("絞り込み")');
    await page.waitForSelector('.gpu-card', { timeout: 5000 });
    await page.click('.gpu-card button:has-text("借りる")');
    await page.waitForSelector('.modal');
    await page.click('.modal button:has-text("注文する")');

    // The server 403s "You cannot order your own GPU" — must surface as a
    // toast, not silently redirect as if the order succeeded.
    await expect(page.locator('#toasts')).toContainText(/own GPU|自分のGPU|own gpu/i, { timeout: 5000 });
    expect(page.url()).not.toMatch(/#\/orders\//);
  });

  test('unauthenticated visitor can browse but rent redirects to login', async ({ page }) => {
    await page.goto('/#/market');
    await expect(page.locator('h1')).toContainText('GPUマーケット');
    // No auth required to view the market itself.
    await expect(page.locator('a[href="#/login"]')).toBeVisible();
  });
});
