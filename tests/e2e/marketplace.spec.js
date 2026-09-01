// tests/e2e/marketplace.spec.js — GPU registration, browse/search, availability toggle.
const { test, expect } = require('@playwright/test');
const { registerAndLoginUI, uniqueId } = require('./helpers');

test.describe('marketplace', () => {
  test('provider registers a GPU, sees it in my-gpus, toggles availability', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'mktprov', role: 'provider' });
    const gpuName = `Market GPU ${uniqueId()}`;

    // 必須 5 項目だけで登録する。以前は 11 項目すべてが必須だった。
    // 位置指定（inputs[n]）ではなく id で埋める — 位置は項目が増減するたびに壊れる。
    await page.goto('/#/gpus/new');
    await page.waitForSelector('#gpu-name');
    await page.selectOption('#gpu-vendor', 'NVIDIA');
    await page.fill('#gpu-name', gpuName);
    await page.fill('#gpu-model', 'RTX 4090');
    await page.fill('#gpu-memory', '24');
    await page.fill('#gpu-price', '1500');
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

  test('the listing form suggests a price for a known model, and refuses to guess for an unknown one', async ({ page }) => {
    // 貸し手はこれまで値段を勘で決めるしかなかった。価格エンジンは実装もテストも
    // 揃っていたのに UI から一度も呼ばれておらず、値段を一つも決めていなかった。
    await registerAndLoginUI(page, { prefix: 'quoteprov', role: 'provider' });
    await page.goto('/#/gpus/new');
    await page.waitForSelector('#gpu-name');

    // 参照表に載っている型番 → 目安を出し、ワンクリックで価格欄に入る
    await page.selectOption('#gpu-vendor', 'NVIDIA');
    await page.fill('#gpu-model', 'RTX 4090');
    await page.fill('#gpu-memory', '24');
    await expect(page.locator('#price-suggestion')).toContainText('参考価格', { timeout: 8000 });
    await page.click('#apply-suggestion');
    await expect(page.locator('#gpu-price')).not.toHaveValue('');

    // 未知の型番 → 数字を作らず、出せない理由を言う
    await page.fill('#gpu-model', 'Totally Made Up 9000');
    await expect(page.locator('#price-suggestion')).toContainText('参照表に無い', { timeout: 8000 });
    await expect(page.locator('#apply-suggestion')).toHaveCount(0);
  });

  test('a minimal listing shows derived specs labelled as estimates, not as declarations', async ({ page }) => {
    // 推定値を申告値として見せると「未確認のものを確認済みに見せる」ことになる。
    // 申告していない項目は「未申告」、機種から補った項目は「推定」と出ること。
    await registerAndLoginUI(page, { prefix: 'derivprov', role: 'provider' });
    const gpuName = `Derived GPU ${uniqueId()}`;
    await page.goto('/#/gpus/new');
    await page.waitForSelector('#gpu-name');
    await page.selectOption('#gpu-vendor', 'NVIDIA');
    await page.fill('#gpu-name', gpuName);
    await page.fill('#gpu-model', 'RTX 4090');
    await page.fill('#gpu-memory', '24');
    await page.fill('#gpu-price', '1700');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#/my-gpus', { timeout: 8000 });

    await page.goto('/#/market');
    await page.fill('input[type="search"]', gpuName);
    await page.click('button:has-text("絞り込み")');
    await page.waitForSelector('.gpu-card', { timeout: 5000 });
    await page.click('.gpu-card h3');
    await page.waitForSelector('.spec-card', { timeout: 5000 });

    const specCard = page.locator('.spec-card');
    // 消費電力は機種の公称 TDP から補われ、「推定」バッジが付く
    await expect(specCard).toContainText('450 W');
    await expect(specCard.locator('.chip-derived').first()).toBeVisible();
    // 申告していない表示専用項目は空欄でも 0 でもなく「未申告」
    await expect(specCard).toContainText('未申告');
  });

  test('the market offers a combined recommended sort, not just single-axis ones', async ({ page }) => {
    // 単軸ソートの寄せ集めでは「安いが不安定」と「高いが堅い」を比べられない。
    // この並びの計算はもともと逆オークション用に書かれたが、この製品には入札が
    // 存在しないためエンドポイントごと削除し、実在の出品を並べる用途に移した。
    await registerAndLoginUI(page, { prefix: 'recmkt', role: 'provider' });
    const gpuName = `Recommend GPU ${uniqueId()}`;
    await page.goto('/#/gpus/new');
    await page.waitForSelector('#gpu-name');
    await page.selectOption('#gpu-vendor', 'NVIDIA');
    await page.fill('#gpu-name', gpuName);
    await page.fill('#gpu-model', 'RTX 4090');
    await page.fill('#gpu-memory', '24');
    await page.fill('#gpu-price', '1900');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => location.hash === '#/my-gpus', { timeout: 8000 });

    await page.goto('/#/market');
    await page.fill('input[type="search"]', gpuName);
    await page.click('button:has-text("絞り込み")');
    await expect(page.locator('.gpu-card')).toHaveCount(1, { timeout: 5000 });

    await page.selectOption('.filter-bar select >> nth=1', 'recommended');
    await expect(page.locator('.gpu-card')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.gpu-card')).toContainText(gpuName);
  });

  test('provider cannot rent their own GPU', async ({ page }) => {
    await registerAndLoginUI(page, { prefix: 'selfprov', role: 'provider' });
    const gpuName = `Self GPU ${uniqueId()}`;
    await page.goto('/#/gpus/new');
    await page.waitForSelector('#gpu-name');
    await page.selectOption('#gpu-vendor', 'AMD');
    await page.fill('#gpu-name', gpuName);
    await page.fill('#gpu-model', 'MI300X');
    await page.fill('#gpu-memory', '192');
    await page.fill('#gpu-price', '2000');
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
