// tests/security/ots-client.test.js
// OpenTimestamps カレンダー・クライアント。
// 重点は「外部が壊れていても呼び出し元を落とさない(fail-soft)」と
// 「単一カレンダーに依存しない(冗長提出)」の 2 点。前者はアンカー生成そのものを
// 外部ネットワークの可用性に人質に取らせないため、後者はカレンダー運営者と
// Strawberry 運営者の結託で外部アンカリングの意味が消えるのを防ぐため。
const ots = require('../../src/security/ots-client');

const ROOT = 'a'.repeat(64);
// 公開 IP を返す DNS リゾルバ（assertPublicUrl のテスト注入口）
const publicResolver = async () => [{ address: '93.184.216.34' }];
const okBody = Buffer.from([0x00, 0x01, 0x02, 0x03]);

const savedEnv = {};
const ENV_KEYS = ['AUDIT_ANCHOR_OTS_ENABLED', 'AUDIT_ANCHOR_CALENDARS', 'AUDIT_ANCHOR_OTS_TIMEOUT_MS'];
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.AUDIT_ANCHOR_OTS_ENABLED = '1';
  process.env.AUDIT_ANCHOR_CALENDARS = 'https://cal-a.example.com,https://cal-b.example.com';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('opt-in / configuration', () => {
  it('is disabled by default — no outbound call without the env flag', async () => {
    delete process.env.AUDIT_ANCHOR_OTS_ENABLED;
    const httpPost = jest.fn();
    await expect(ots.submitRoot(ROOT, { httpPost, resolver: publicResolver })).resolves.toEqual([]);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('reads the calendar list from env, falling back to the public pool', () => {
    expect(ots.calendars()).toEqual(['https://cal-a.example.com', 'https://cal-b.example.com']);
    delete process.env.AUDIT_ANCHOR_CALENDARS;
    expect(ots.calendars()).toEqual(ots.DEFAULT_CALENDARS);
    // 冗長性は本質的要件 — 既定で複数カレンダーを持つこと
    expect(ots.DEFAULT_CALENDARS.length).toBeGreaterThan(1);
  });

  it('normalizes a trailing slash when building the digest URL', () => {
    expect(ots.digestUrl('https://x.example.com/')).toBe('https://x.example.com/digest');
    expect(ots.digestUrl('https://x.example.com')).toBe('https://x.example.com/digest');
  });

  it('rejects a malformed root instead of submitting garbage', async () => {
    await expect(ots.submitRoot('not-a-root', { resolver: publicResolver })).rejects.toThrow(/64-character hex/);
  });
});

describe('submission', () => {
  it('submits the raw 32-byte digest to every calendar and stores the receipt', async () => {
    const httpPost = jest.fn().mockResolvedValue({ data: okBody });
    const receipts = await ots.submitRoot(ROOT, { httpPost, resolver: publicResolver, now: () => 'T0' });

    expect(httpPost).toHaveBeenCalledTimes(2);
    const [url, body, cfg] = httpPost.mock.calls[0];
    expect(url).toBe('https://cal-a.example.com/digest');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body).toHaveLength(32); // hex 64 文字 = 生 32 バイト
    expect(body.toString('hex')).toBe(ROOT);
    expect(cfg.responseType).toBe('arraybuffer');
    expect(cfg.timeout).toBeGreaterThan(0);
    // 悪意ある/故障したカレンダーがメモリを食い潰さないように上限を課す
    expect(cfg.maxContentLength).toBe(ots.MAX_RECEIPT_BYTES);

    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ root: ROOT, status: 'submitted', submittedAt: 'T0', error: null });
    expect(Buffer.from(receipts[0].receiptB64, 'base64')).toEqual(okBody);
  });

  it('keeps the successful calendars when one fails', async () => {
    const httpPost = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ data: okBody });
    const receipts = await ots.submitRoot(ROOT, { httpPost, resolver: publicResolver });

    expect(receipts.map((r) => r.status)).toEqual(['failed', 'submitted']);
    expect(receipts[0].error).toMatch(/ECONNREFUSED/);
    expect(receipts[0].receiptB64).toBeNull();
  });

  it('does not throw when every calendar is down (fail-soft)', async () => {
    // アンカー生成は完全にローカルで完結する。外部提出の失敗でアンカーを失っては本末転倒。
    const httpPost = jest.fn().mockRejectedValue(new Error('network unreachable'));
    const receipts = await ots.submitRoot(ROOT, { httpPost, resolver: publicResolver });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => r.status === 'failed')).toBe(true);
  });

  it('treats an empty or oversized response as a failure, not a valid receipt', async () => {
    const empty = jest.fn().mockResolvedValue({ data: Buffer.alloc(0) });
    const r1 = await ots.submitRoot(ROOT, { httpPost: empty, resolver: publicResolver });
    expect(r1.every((r) => r.status === 'failed' && /empty/.test(r.error))).toBe(true);

    const huge = jest.fn().mockResolvedValue({ data: Buffer.alloc(ots.MAX_RECEIPT_BYTES + 1) });
    const r2 = await ots.submitRoot(ROOT, { httpPost: huge, resolver: publicResolver });
    expect(r2.every((r) => r.status === 'failed' && /too large/.test(r.error))).toBe(true);
  });

  it('blocks a calendar that resolves to a private address (SSRF)', async () => {
    // カレンダー URL は env 由来なので内部アドレスへ向けられうる。webhook.js と同じ扱い。
    const httpPost = jest.fn();
    const privateResolver = async () => [{ address: '169.254.169.254' }];
    const receipts = await ots.submitRoot(ROOT, { httpPost, resolver: privateResolver });

    expect(httpPost).not.toHaveBeenCalled();
    expect(receipts.every((r) => r.status === 'blocked')).toBe(true);
    expect(receipts[0].error).toMatch(/SSRF blocked/);
  });

  it('returns [] when the calendar list is empty', async () => {
    process.env.AUDIT_ANCHOR_CALENDARS = ' , ';
    const httpPost = jest.fn();
    await expect(ots.submitRoot(ROOT, { httpPost, resolver: publicResolver })).resolves.toEqual([]);
    expect(httpPost).not.toHaveBeenCalled();
  });
});
