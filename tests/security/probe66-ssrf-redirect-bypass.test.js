// tests/security/probe66-ssrf-redirect-bypass.test.js
// Regression for an SSRF redirect-bypass: assertPublicUrl() validates only the
// FIRST URL's resolved IP. axios's default maxRedirects:5 means a validated public
// webhook URL that responds with a 30x redirect to http://127.0.0.1/ or the cloud
// metadata endpoint (169.254.169.254) would be silently followed, defeating the guard.
//
// Fix: AXIOS_SAFE_CONFIG (notifier.js) and SAFE_CONFIG (resilient-notify.js) set
// maxRedirects:0, so a redirect response is treated as an error and never followed.
//
// These tests assert behavior with a real local HTTP server that issues a redirect,
// plus source-level guards that the config carries maxRedirects:0.

const http = require('http');
const axios = require('axios');

// ── Behavioral: axios with maxRedirects:0 must NOT follow a redirect ────────────

describe('axios maxRedirects:0 blocks redirect following (SSRF bypass defense)', () => {
  let redirectServer;
  let redirectPort;
  let followed = false;

  beforeAll((done) => {
    // Server that 302-redirects "/webhook" to "/internal" and records if /internal is hit.
    redirectServer = http.createServer((req, res) => {
      if (req.url === '/webhook') {
        res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/internal` });
        res.end();
      } else if (req.url === '/internal') {
        followed = true; // if we get here, the redirect was followed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secret: 'internal-data' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    redirectServer.listen(0, '127.0.0.1', () => {
      redirectPort = redirectServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (redirectServer) redirectServer.close(done);
    else done();
  });

  beforeEach(() => { followed = false; });

  it('with maxRedirects:0, a 302 is surfaced as an error and the target is NOT fetched', async () => {
    let threw = false;
    try {
      await axios.post(
        `http://127.0.0.1:${redirectPort}/webhook`,
        { content: 'hi' },
        { timeout: 5000, maxRedirects: 0 }
      );
    } catch (e) {
      threw = true;
      // axios surfaces a 3xx as an error when maxRedirects:0 (status in error.response)
      expect(e.response ? e.response.status : 0).toBeGreaterThanOrEqual(300);
    }
    expect(threw).toBe(true);
    expect(followed).toBe(false); // critical: the internal endpoint was never reached
  });

  it('control: with default maxRedirects, the redirect IS followed (demonstrates the risk)', async () => {
    // This documents WHY the fix matters: without maxRedirects:0 the internal endpoint is hit.
    const res = await axios.post(
      `http://127.0.0.1:${redirectPort}/webhook`,
      { content: 'hi' },
      { timeout: 5000 } // default maxRedirects:5
    );
    expect(res.status).toBe(200);
    expect(followed).toBe(true); // redirect was followed to the "internal" target
  });
});

// ── Source guards: both notify modules must carry maxRedirects:0 ────────────────

describe('notify modules disable redirect following in their shared axios config', () => {
  it('notifier.js AXIOS_SAFE_CONFIG sets maxRedirects:0', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/notifier.js'), 'utf-8'
    );
    expect(src).toMatch(/AXIOS_SAFE_CONFIG\s*=\s*Object\.freeze\(\{[\s\S]*maxRedirects:\s*0[\s\S]*\}\)/);
  });

  it('resilient-notify.js SAFE_CONFIG sets maxRedirects:0', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/resilient-notify.js'), 'utf-8'
    );
    expect(src).toMatch(/SAFE_CONFIG\s*=\s*Object\.freeze\(\{[\s\S]*maxRedirects:\s*0[\s\S]*\}\)/);
  });

  it('resilient-notify.js applies SAFE_CONFIG to every axios.post call', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/utils/resilient-notify.js'), 'utf-8'
    );
    // Each of the 4 channel branches must reference SAFE_CONFIG
    const matches = src.match(/SAFE_CONFIG/g) || [];
    // 1 definition + at least 4 usages
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });
});

// ── Integration: notifier send funcs reject a redirecting webhook ───────────────

describe('notifier webhook send rejects a redirecting endpoint (no silent SSRF follow)', () => {
  let redirectServer;
  let redirectPort;
  let internalHit = false;

  beforeAll((done) => {
    redirectServer = http.createServer((req, res) => {
      if (req.url.startsWith('/hook')) {
        res.writeHead(301, { Location: `http://127.0.0.1:${redirectPort}/meta` });
        res.end();
      } else if (req.url === '/meta') {
        internalHit = true;
        res.writeHead(200);
        res.end('{}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    redirectServer.listen(0, '127.0.0.1', () => {
      redirectPort = redirectServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (redirectServer) redirectServer.close(done);
    else done();
  });

  it('sendNotification(webhook) to a 301-redirecting URL does not reach the redirect target', async () => {
    // Allow private webhooks so assertPublicUrl lets 127.0.0.1 through — this isolates
    // the redirect behavior (the real guard would block 127.0.0.1 outright; here we prove
    // that even if the FIRST host were public, the redirect itself is not followed).
    const prev = process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS;
    process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS = 'true';
    // Re-require to pick up env at call time (ssrf-guard reads env per-call, so no reset needed).
    const { sendNotification, NotifyType } = require('../../src/utils/notifier');
    internalHit = false;
    let threw = false;
    try {
      await sendNotification(NotifyType.WEBHOOK, 'test', { webhookUrl: `http://127.0.0.1:${redirectPort}/hook` });
    } catch (_) {
      threw = true; // withRetry exhausts and rethrows; the redirect is an error
    } finally {
      if (prev === undefined) delete process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS;
      else process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS = prev;
    }
    expect(threw).toBe(true);
    expect(internalHit).toBe(false); // redirect target never reached
  });
});
