// tests/e2e/accessibility.spec.js — regression guards for WCAG 2.2 fixes made
// directly in public/css/{tokens,app}.css (contrast + focus-not-obscured).
// This does not replace a full automated a11y audit (no axe-core dependency
// has been introduced) -- it locks in the two specific, hand-verified fixes
// so a future CSS edit can't silently regress them.
const { test, expect } = require('@playwright/test');

test.describe('accessibility regression guards', () => {
  test('scroll-padding-top keeps focus-driven scrolling clear of the sticky header (SC 2.4.11)', async ({ page }) => {
    await page.goto('/#/market');
    const scrollPaddingTop = await page.evaluate(() =>
      getComputedStyle(document.documentElement).scrollPaddingTop);
    // Must be >= the sticky .app-header's real rendered height (measured ~64px
    // in this environment) so a keyboard-focused element scrolled into view
    // never ends up hidden behind the header.
    const headerHeight = await page.locator('.app-header').evaluate((el) => el.getBoundingClientRect().height);
    expect(parseFloat(scrollPaddingTop)).toBeGreaterThanOrEqual(headerHeight);
  });

  test('chip/badge text colors are legible against their tint background (light theme)', async ({ page }) => {
    // reliability/attestation chips only render with real data attached to a
    // GPU listing/order, which is out of scope here -- this just confirms
    // the CSS tokens the earlier contrast fix touched are wired through to
    // the rendered page (not literally computing a contrast ratio: no
    // axe-core/color-contrast dependency has been added for that).
    await page.goto('/#/login');
    const successColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-success').trim());
    const warningColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-warning').trim());
    const dangerColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim());
    expect(successColor.toLowerCase()).toBe('#167a43');
    expect(warningColor.toLowerCase()).toBe('#8a5c18');
    expect(dangerColor.toLowerCase()).toBe('#c22a3d');
  });
});
