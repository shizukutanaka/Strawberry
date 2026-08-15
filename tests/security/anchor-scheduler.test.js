// tests/security/anchor-scheduler.test.js
// 監査ログの定期増分アンカリング・ジョブ。
// これが無かったために audit-anchor.js は完成していながら src/ のどこからも呼ばれず、
// アンカーが 1 つも生成されていなかった（docs は「残るは OTS 提出のみ」と書いていた）。
const fs = require('fs');
const os = require('os');
const path = require('path');

const scheduler = require('../../src/security/anchor-scheduler');
const auditAnchor = require('../../src/security/audit-anchor');
const otsClient = require('../../src/security/ots-client');
const { appendAuditLog } = require('../../src/utils/audit-log');

let dir;
const savedEnv = {};
const ENV_KEYS = [
  'AUDIT_LOG_PATH', 'AUDIT_HASH_PATH', 'AUDIT_ANCHOR_PATH',
  'AUDIT_ANCHOR_RECEIPT_PATH', 'AUDIT_ANCHOR_OTS_ENABLED', 'AUDIT_ANCHOR_INTERVAL_MS',
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-sched-'));
  process.env.AUDIT_LOG_PATH = path.join(dir, 'audit.log');
  process.env.AUDIT_HASH_PATH = path.join(dir, 'audit.hash');
  process.env.AUDIT_ANCHOR_PATH = path.join(dir, 'anchors.jsonl');
  process.env.AUDIT_ANCHOR_RECEIPT_PATH = path.join(dir, 'receipts.jsonl');
  delete process.env.AUDIT_ANCHOR_OTS_ENABLED; // 既定は無効
});

afterEach(() => {
  scheduler.stop();
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runOnce', () => {
  it('anchors new audit entries and records the cycle in the audit log itself', async () => {
    appendAuditLog('login', { ip: '1.1.1.1' }, 'alice');
    appendAuditLog('order', { id: 'o1' }, 'bob');

    const { anchor } = await scheduler.runOnce();
    expect(anchor).not.toBeNull();
    expect(anchor.count).toBe(2);
    expect(anchor.root).toMatch(/^[0-9a-f]{64}$/);
    expect(auditAnchor.readAnchors()).toHaveLength(1);

    // サイクル自体が監査証跡に残る
    const entries = auditAnchor.parseEntries(fs.readFileSync(process.env.AUDIT_LOG_PATH, 'utf-8'));
    const bookkeeping = entries.find((e) => e.action === 'audit_anchor_created');
    expect(bookkeeping.detail.root).toBe(anchor.root);
    expect(bookkeeping.detail.toIndex).toBe(1);
  });

  it('does nothing when there are no new entries', async () => {
    appendAuditLog('login', {}, 'alice');
    await scheduler.runOnce();
    const second = await scheduler.runOnce();
    // 2 回目に残るのは自身の簿記エントリだけ → 空回りしない
    expect(second.anchor).toBeNull();
    expect(auditAnchor.readAnchors()).toHaveLength(1);
  });

  it('anchors again once real activity resumes, covering the bookkeeping entry too', async () => {
    appendAuditLog('login', {}, 'alice');
    const first = await scheduler.runOnce();
    appendAuditLog('pay', { sats: 10 }, 'bob');
    const second = await scheduler.runOnce();

    expect(second.anchor).not.toBeNull();
    expect(second.anchor.fromIndex).toBe(first.anchor.toIndex + 1);
    expect(second.anchor.prevAnchorRoot).toBe(first.anchor.root);
    // 間に挟まった audit_anchor_created も木に含まれる（index = ログ行番号を保つ）
    expect(second.anchor.count).toBe(2);
  });

  it('is re-entrancy safe — a concurrent call is skipped, not run twice', async () => {
    appendAuditLog('login', {}, 'alice');
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const anchored = [a, b].filter((r) => r.anchor).length;
    expect(anchored).toBe(1);
    expect(auditAnchor.readAnchors()).toHaveLength(1);
  });

  it('records log truncation as an auditable event and resumes from index 0', async () => {
    appendAuditLog('a', {}, 'u');
    appendAuditLog('b', {}, 'u');
    await scheduler.runOnce();

    // ローテーション/削除/切詰めを模す
    fs.writeFileSync(process.env.AUDIT_LOG_PATH,
      JSON.stringify({ timestamp: 't', action: 'fresh', detail: {}, user: 'u' }) + '\n');
    const { anchor } = await scheduler.runOnce();

    expect(anchor.fromIndex).toBe(0);
    expect(anchor.truncationDetected).toBe(true);
    const entries = auditAnchor.parseEntries(fs.readFileSync(process.env.AUDIT_LOG_PATH, 'utf-8'));
    expect(entries.some((e) => e.action === 'audit_anchor_log_truncated')).toBe(true);
  });
});

describe('OTS submission wiring', () => {
  it('does not submit when OTS is disabled, but still produces the anchor', async () => {
    const spy = jest.spyOn(otsClient, 'submitRoot');
    appendAuditLog('login', {}, 'alice');
    const { anchor, receipts } = await scheduler.runOnce();

    expect(anchor).not.toBeNull();
    // submitRoot は呼ばれるが、無効フラグにより即 [] を返す（外部 I/O は起きない）
    expect(spy).toHaveBeenCalledWith(anchor.root);
    expect(receipts).toEqual([]);
    expect(fs.existsSync(process.env.AUDIT_ANCHOR_RECEIPT_PATH)).toBe(false);
  });

  it('persists receipts keyed by root so third parties can fetch them', async () => {
    jest.spyOn(otsClient, 'submitRoot').mockResolvedValue([
      { root: 'r', calendar: 'https://cal-a', status: 'submitted', submittedAt: 'T', receiptB64: 'AAEC', error: null },
      { root: 'r', calendar: 'https://cal-b', status: 'failed', submittedAt: 'T', receiptB64: null, error: 'boom' },
    ]);
    appendAuditLog('login', {}, 'alice');
    const { anchor, receipts } = await scheduler.runOnce();

    expect(receipts).toHaveLength(2);
    const stored = scheduler.readReceipts('r');
    expect(stored).toHaveLength(2);
    expect(stored[0].receiptB64).toBe('AAEC');

    // 提出結果の内訳が監査ログに残る
    const entries = auditAnchor.parseEntries(fs.readFileSync(process.env.AUDIT_LOG_PATH, 'utf-8'));
    const bk = entries.find((e) => e.action === 'audit_anchor_created');
    expect(bk.detail).toMatchObject({ root: anchor.root, otsSubmitted: 1, otsAttempted: 2 });
  });

  it('keeps the anchor when OTS submission blows up entirely', async () => {
    // 外部の可用性にアンカーを人質に取らせない
    jest.spyOn(otsClient, 'submitRoot').mockRejectedValue(new Error('calendar pool down'));
    appendAuditLog('login', {}, 'alice');
    const { anchor } = await scheduler.runOnce();

    expect(anchor).not.toBeNull();
    expect(auditAnchor.readAnchors()).toHaveLength(1);
  });
});

describe('start / stop', () => {
  it('starts a single unref-ed timer and stops cleanly', () => {
    process.env.AUDIT_ANCHOR_INTERVAL_MS = '60000';
    const setSpy = jest.spyOn(global, 'setInterval');
    scheduler.start();
    scheduler.start(); // 多重 start は無視される
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0][1]).toBe(60000);
    scheduler.stop();
    scheduler.stop(); // 冪等
  });
});

describe('receiptPath', () => {
  it('derives a sibling receipts file from the anchor path', () => {
    delete process.env.AUDIT_ANCHOR_RECEIPT_PATH;
    process.env.AUDIT_ANCHOR_PATH = '/tmp/x/anchors.jsonl';
    expect(scheduler.receiptPath()).toBe('/tmp/x/anchors-receipts.jsonl');
  });
});
