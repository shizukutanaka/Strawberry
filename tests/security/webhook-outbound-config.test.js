// tests/security/webhook-outbound-config.test.js
// 残存ギャップの回帰: src/api/webhook.js の sendWebhook は assertPublicUrl() で
// 最初の URL を検証していたが axios.post に SAFE_AXIOS_CONFIG を渡していなかった。
// axios 既定 maxRedirects:5 のため、検証済み公開 URL が 30x で内部アドレスへ
// 誘導するリダイレクト迂回 SSRF が残っていた。タイムアウトも未設定だった。
// 同型の修正は notifier.js / resilient-notify.js へ先行適用済み（probe66 参照）。

const http = require('http');
const { SAFE_AXIOS_CONFIG } = require('../../src/utils/ssrf-guard');

describe('SAFE_AXIOS_CONFIG（ssrf-guard 共有の外向き axios 設定）', () => {
  it('リダイレクト追従禁止・タイムアウト・サイズ上限を持つ', () => {
    expect(SAFE_AXIOS_CONFIG.maxRedirects).toBe(0);
    expect(SAFE_AXIOS_CONFIG.timeout).toBeGreaterThan(0);
    expect(SAFE_AXIOS_CONFIG.maxContentLength).toBeGreaterThan(0);
    expect(SAFE_AXIOS_CONFIG.maxBodyLength).toBeGreaterThan(0);
    expect(Object.isFrozen(SAFE_AXIOS_CONFIG)).toBe(true);
  });
});

describe('sendWebhook が SSRF 安全設定付きで送信する', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    // テスト内では loopback 宛を許可して assertPublicUrl を通過させる
    process.env.SSRF_ALLOW_PRIVATE_WEBHOOKS = '1';
    process.env.GENERIC_WEBHOOK = 'http://127.0.0.1:9/hook';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('axios.post に maxRedirects:0 と timeout を含む SAFE_AXIOS_CONFIG を渡す', async () => {
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockResolvedValue({ status: 200 });
    const { sendWebhook } = require('../../src/api/webhook');

    await sendWebhook('test_event', { ok: true });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, , config] = axios.post.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9/hook');
    expect(config.maxRedirects).toBe(0);
    expect(config.timeout).toBeGreaterThan(0);
  });

  it('実サーバで 302 リダイレクトを追わない（ガード迂回を実証）', async () => {
    let internalHit = false;
    const server = http.createServer((req, res) => {
      if (req.url === '/hook') {
        res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/internal` });
        res.end();
      } else if (req.url === '/internal') {
        internalHit = true;
        res.writeHead(200).end('{}');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = server.address().port;
      process.env.GENERIC_WEBHOOK = `http://127.0.0.1:${port}/hook`;
      jest.resetModules();
      const { sendWebhook } = require('../../src/api/webhook');
      // 302 はエラー扱い → 全送信失敗で throw
      await expect(sendWebhook('ev', {})).rejects.toThrow('全Webhook送信失敗');
      expect(internalHit).toBe(false); // リダイレクト先へは到達しない
    } finally {
      server.close();
    }
  });
});

describe('lightning-api の外向き呼び出しに安全設定がある', () => {
  it('両プロバイダとも SAFE_AXIOS_CONFIG を axios.post に渡す（ソースガード）', () => {
    const src = require('fs').readFileSync(
      require.resolve('../../src/api/utils/lightning-api.js'), 'utf-8'
    );
    const calls = src.match(/axios\.post\([\s\S]*?SAFE_AXIOS_CONFIG/g) || [];
    expect(calls.length).toBe(2); // opennode + lnbits
  });
});
