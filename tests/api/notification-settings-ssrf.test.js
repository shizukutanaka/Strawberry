// SSRF registration-time checks for POST /api/v1/notification-settings/:userId.
//
// The route historically checked webhook URLs with regexes over the URL string,
// which missed:
//   - userinfo shims        http://example.com@127.0.0.1/
//   - numeric IPv4 literals http://2130706433/ , http://0x7f000001/ , http://127.1/
//   - IPv4-mapped IPv6      http://[::ffff:7f00:1]/
//   - hostnames that resolve to private addresses (nip.io style)
// The checks now go through the shared ssrf-guard classifier on the URL-parsed
// hostname, plus a DNS pre-check at registration.
const dns = require('dns');
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

async function registerAndLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 24);
  await request(app).post('/api/v1/users/register')
    .send({ username: u, email: `${u}@example.com`, password: 'Test1234!' });
  const login = await request(app).post('/api/v1/users/login')
    .send({ email: `${u}@example.com`, password: 'Test1234!' });
  const id = login.body.user?.id || UserRepository.getByEmail(`${u}@example.com`)?.id;
  return { token: login.body.token, id };
}

describe('notification-settings SSRF registration checks', () => {
  let user;

  beforeAll(async () => {
    user = await registerAndLogin('nssrf');
  });

  afterEach(() => {
    if (dns.promises.lookup.mockRestore) dns.promises.lookup.mockRestore();
    delete process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS;
  });

  const post = (body) => request(app)
    .post(`/api/v1/notification-settings/${user.id}`)
    .set('Authorization', `Bearer ${user.token}`)
    .send(body);

  it('still rejects literal private/loopback targets', async () => {
    for (const url of [
      'http://127.0.0.1:9200/delete-all',
      'http://localhost:8080/internal',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/',
    ]) {
      const res = await post({ genericWebhook: url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects userinfo-shimmed loopback URLs (regex bypass)', async () => {
    const res = await post({ genericWebhook: 'http://attacker.example@127.0.0.1:9200/' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects numeric IPv4 literals via WHATWG host normalization', async () => {
    // 2130706433 === 127.0.0.1 ; 0x7f000001 === 127.0.0.1 ; 127.1 === 127.0.0.1
    for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/']) {
      const res = await post({ genericWebhook: url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects IPv4-mapped IPv6 literals including hex-embedded forms', async () => {
    const res = await post({ genericWebhook: 'http://[::ffff:7f00:1]/' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a public-looking hostname that resolves to a private address', async () => {
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const res = await post({ genericWebhook: 'https://hook.public.example/webhook' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/private/i);
  });

  it('accepts a hostname that resolves to a public address', async () => {
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const res = await post({ genericWebhook: 'https://hook.public.example/webhook' });
    expect(res.statusCode).toBe(200);
  });

  it('tolerates DNS failure at registration (send-time check stays authoritative)', async () => {
    jest.spyOn(dns.promises, 'lookup').mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const res = await post({ genericWebhook: 'https://not-yet-up.example/webhook' });
    expect(res.statusCode).toBe(200);
  });

  it('applies the same checks to per-event webhooks[] entries', async () => {
    const res = await post({
      webhooks: [{ event: 'order_created', url: 'http://10.0.0.5/hook' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('SSRF_ALLOW_PRIVATE_WEBHOOKS allows private webhook registration (self-hosted escape hatch)', async () => {
    process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS = '1';
    const res = await post({ genericWebhook: 'http://127.0.0.1:9000/internal-hook' });
    expect(res.statusCode).toBe(200);
  });
});
