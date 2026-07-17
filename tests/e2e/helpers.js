// tests/e2e/helpers.js — shared setup for Playwright E2E specs.
// Every helper takes unique, timestamp-suffixed identifiers so parallel test
// files (and repeated local runs against a server that isn't reset between
// runs, unlike jest's globalSetup) never collide on username/email uniqueness
// constraints enforced by src/api/routes/user/index.js.

function uniqueId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

// Attaches console/page-error tracking to `page` and returns the accumulated
// array. Chrome logs a "Failed to load resource: 404" console error for
// /favicon.ico on every navigation regardless of app code (no <link rel=icon>
// is served) — that's a browser default, not a bug, so it's filtered out here
// once rather than every spec re-deriving the same filter.
function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if ((msg.location()?.url || '').includes('favicon')) return;
    errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

// Registers + logs in via the UI (exercises the real register->auto-login
// flow built in public/js/pages/register.js, not just the API).
async function registerAndLoginUI(page, { prefix, role } = {}) {
  const id = uniqueId();
  const username = `${prefix || 'user'}${id}`.slice(0, 28);
  const email = `${username}@example.com`;
  const password = 'Test1234!';

  await page.goto('/#/register');
  await page.waitForSelector('#reg-username');
  await page.fill('#reg-username', username);
  await page.fill('#reg-email', email);
  await page.fill('#reg-password', password);
  await page.fill('#reg-password-confirm', password);
  if (role === 'provider') await page.check('#reg-provider');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.hash === '#/market', { timeout: 8000 });
  // Also expose the token the UI flow stored, so a test can mix UI actions
  // with direct API calls (e.g. fetching payment state to promote an admin)
  // without a separate api* helper call re-registering the same user.
  const token = await page.evaluate(() => localStorage.getItem('strawberry.token'));

  return { username, email, password, id, token };
}

async function loginUI(page, email, password) {
  await page.goto('/#/login');
  await page.waitForSelector('#login-email');
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.hash === '#/market', { timeout: 8000 });
  return page.evaluate(() => localStorage.getItem('strawberry.token'));
}

async function logout(page) {
  await page.evaluate(() => localStorage.clear());
}

// Registers a user via the API directly (faster than the UI form) and
// returns their bearer token — used for setup steps that aren't themselves
// under test (e.g. "a provider already has a GPU listed" as a precondition
// for a renter-focused test).
async function apiRegisterAndLogin(request, baseURL, { prefix, role } = {}) {
  const id = uniqueId();
  const username = `${prefix || 'api'}${id}`.slice(0, 28);
  const email = `${username}@example.com`;
  const password = 'Test1234!';
  await request.post(`${baseURL}/api/v1/users/register`, {
    data: { username, email, password, ...(role ? { role } : {}) },
  });
  const loginRes = await request.post(`${baseURL}/api/v1/users/login`, { data: { email, password } });
  const body = await loginRes.json();
  return { username, email, password, id, token: body.token };
}

async function apiCreateGpu(request, baseURL, token, overrides = {}) {
  const id = uniqueId();
  const res = await request.post(`${baseURL}/api/v1/gpus`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: `E2E GPU ${id}`,
      vendor: 'NVIDIA',
      model: 'RTX 4090',
      apiType: 'CUDA',
      driverVersion: '550.90.07',
      os: 'Ubuntu 22.04',
      arch: 'x86_64',
      memoryGB: 24,
      clockMHz: 2500,
      powerWatt: 450,
      pricePerHour: 1000,
      ...overrides,
    },
  });
  const body = await res.json();
  return body.gpu;
}

// Drives an order all the way to 'completed' via the bank_transfer path
// (admin-approvable synchronously, unlike Lightning which requires either a
// real payer or direct mock-ledger manipulation only available from within
// the Node process — see tests/api/lightning-payment-e2e-smoke.test.js for
// that path's coverage at the jest layer instead). Promotes its own admin
// account internally so callers don't need to plumb one through.
async function apiCompleteOrderCycle(request, baseURL, { providerToken, renterToken, gpuId, durationMinutes = 60 }) {
  const orderRes = await request.post(`${baseURL}/api/v1/orders`, {
    headers: { Authorization: `Bearer ${renterToken}` },
    data: { gpuId, durationMinutes },
  });
  const { orderId } = await orderRes.json();

  await request.post(`${baseURL}/api/v1/orders/${orderId}/accept`, {
    headers: { Authorization: `Bearer ${providerToken}` },
  });

  const payRes = await request.post(`${baseURL}/api/v1/payments/order/${orderId}`, {
    headers: { Authorization: `Bearer ${renterToken}` },
    data: { paymentMethod: 'bank_transfer' },
  });
  const { paymentId } = await payRes.json();

  const admin = await apiRegisterAndLogin(request, baseURL, { prefix: 'e2eadmin' });
  const adminToken = await promoteToAdmin(request, baseURL, admin.email, admin.password);
  await request.post(`${baseURL}/api/v1/payments/manual/approve/${paymentId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  await request.post(`${baseURL}/api/v1/orders/${orderId}/start`, {
    headers: { Authorization: `Bearer ${renterToken}` },
  });
  await request.post(`${baseURL}/api/v1/orders/${orderId}/stop`, {
    headers: { Authorization: `Bearer ${renterToken}` },
  });

  return { orderId, paymentId, adminToken };
}

// Promotes a freshly-registered user to admin by editing data/users.json
// directly — there is no self-service admin-promotion API by design (admin
// is a privileged role an operator assigns out of band). Mirrors the pattern
// used throughout manual verification earlier in this project's history.
const fs = require('fs');
const path = require('path');
const DATA_USERS = path.join(__dirname, '../../data/users.json');

async function promoteToAdmin(request, baseURL, email, password) {
  const users = JSON.parse(fs.readFileSync(DATA_USERS, 'utf8'));
  const idx = users.findIndex((u) => u.email === email);
  if (idx === -1) throw new Error(`user ${email} not found in data/users.json`);
  users[idx].role = 'admin';
  fs.writeFileSync(DATA_USERS, JSON.stringify(users, null, 2));
  const loginRes = await request.post(`${baseURL}/api/v1/users/login`, { data: { email, password } });
  const body = await loginRes.json();
  return body.token;
}

module.exports = {
  uniqueId,
  trackConsoleErrors,
  registerAndLoginUI,
  loginUI,
  logout,
  apiRegisterAndLogin,
  apiCreateGpu,
  apiCompleteOrderCycle,
  promoteToAdmin,
};
