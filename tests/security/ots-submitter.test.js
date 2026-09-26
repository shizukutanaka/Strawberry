// tests/security/ots-submitter.test.js
// §18 監査ログの対外アンカリング: OTS 提出・レシート台帳・確定確認・増分アンカー。
// 外部ネットワークには出ない（Mock アダプタ）。I/O は tmpdir へ向ける。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  submitAnchor, anchorAndSubmit, upgradePending, readReceipts, getOtsStatus,
  digestOfAnchor, createMockOtsAdapter, DEFAULT_CALENDARS,
} = require('../../src/security/ots-submitter');
const { anchorNewEntries, readAnchors } = require('../../src/security/audit-anchor');

let dir;
let paths;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-test-'));
  paths = {
    logPath: path.join(dir, 'audit.log'),
    anchorPath: path.join(dir, 'anchors.jsonl'),
    otsPath: path.join(dir, 'ots.jsonl'),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeLog(entries) {
  fs.writeFileSync(paths.logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const entry = (i) => ({ id: i, action: 'test', ts: `2026-01-0${i}T00:00:00Z` });

describe('digestOfAnchor', () => {
  it('extracts the merkle root hex as the OTS digest', () => {
    expect(digestOfAnchor({ root: 'ab'.repeat(32) })).toBe('ab'.repeat(32));
    expect(() => digestOfAnchor({ root: 'nope' })).toThrow(/sha256/);
    expect(() => digestOfAnchor({})).toThrow(/sha256/);
  });
});

describe('submitAnchor', () => {
  const anchor = { root: 'cd'.repeat(32) };

  it('submits to all calendars and reports pending', async () => {
    const rec = await submitAnchor(anchor, { adapter: createMockOtsAdapter() });
    expect(rec.status).toBe('pending');
    expect(rec.digest).toBe(anchor.root);
    expect(rec.calendars).toHaveLength(DEFAULT_CALENDARS.length);
    expect(rec.calendars.every((c) => c.receipt)).toBe(true);
  });

  it('records per-calendar failures without throwing (partial success stays pending)', async () => {
    const flaky = {
      async submit(d, url) {
        if (url.includes('alice')) return 'b64-receipt';
        throw new Error('calendar timeout');
      },
      async fetchAttestation() { return null; },
    };
    const rec = await submitAnchor(anchor, { adapter: flaky, calendars: DEFAULT_CALENDARS });
    expect(rec.status).toBe('pending'); // 1 カレンダー受理で十分
    expect(rec.calendars.filter((c) => c.error)).toHaveLength(DEFAULT_CALENDARS.length - 1);
  });

  it('status=failed when every calendar fails; disabled when no adapter', async () => {
    const dead = { async submit() { throw new Error('down'); }, async fetchAttestation() { return null; } };
    const rec = await submitAnchor(anchor, { adapter: dead, calendars: ['https://x'] });
    expect(rec.status).toBe('failed');
    const off = await submitAnchor(anchor, { adapter: null });
    expect(off.status).toBe('disabled');
    expect(off.calendars).toHaveLength(0);
  });
});

describe('anchorNewEntries (incremental anchoring)', () => {
  it('anchors only entries past the previous anchor toIndex', () => {
    writeLog([entry(1), entry(2), entry(3)]);
    const a1 = anchorNewEntries(paths);
    expect(a1.fromIndex).toBe(0);
    expect(a1.toIndex).toBe(2);
    expect(a1.count).toBe(3);

    // No new entries → null (no duplicate anchors)
    expect(anchorNewEntries(paths)).toBeNull();

    // Append two → incremental anchor covering exactly the new tail
    fs.appendFileSync(paths.logPath, JSON.stringify(entry(4)) + '\n' + JSON.stringify(entry(5)) + '\n');
    const a2 = anchorNewEntries(paths);
    expect(a2.fromIndex).toBe(3);
    expect(a2.toIndex).toBe(4);
    expect(a2.count).toBe(2);
  });

  it('re-anchors the full log when the log rotated/shrank', () => {
    writeLog([entry(1), entry(2), entry(3), entry(4)]);
    anchorNewEntries(paths);
    writeLog([entry(9), entry(8)]); // rotated log is shorter than last toIndex
    const a = anchorNewEntries(paths);
    expect(a.fromIndex).toBe(0);
    expect(a.count).toBe(2);
  });
});

describe('anchorAndSubmit + upgradePending', () => {
  it('creates an anchor, records a pending receipt, then confirms it', async () => {
    writeLog([entry(1), entry(2)]);
    const adapter = createMockOtsAdapter(); // confirmAfterMs=0 → attestation immediately available
    const result = await anchorAndSubmit({ ...paths, adapter });
    expect(result.anchor.count).toBe(2);
    expect(result.receipt.status).toBe('pending');
    expect(readReceipts(paths.otsPath)).toHaveLength(1);

    // Second call with unchanged log → no new anchor, no new receipt
    expect(await anchorAndSubmit({ ...paths, adapter })).toBeNull();
    expect(readReceipts(paths.otsPath)).toHaveLength(1);

    const up = await upgradePending({ adapter, otsPath: paths.otsPath });
    expect(up.confirmed).toBe(1);
    const rec = readReceipts(paths.otsPath)[0];
    expect(rec.status).toBe('confirmed');
    expect(rec.confirmedAt).toBeTruthy();
    expect(rec.calendars.find((c) => c.attestation)).toBeTruthy();
  });

  it('leaves receipts pending while attestation is unavailable', async () => {
    writeLog([entry(1)]);
    const adapter = createMockOtsAdapter({ confirmAfterMs: 60 * 60 * 1000 }); // BTC 確定前
    await anchorAndSubmit({ ...paths, adapter });
    const up = await upgradePending({ adapter, otsPath: paths.otsPath });
    expect(up.confirmed).toBe(0);
    expect(readReceipts(paths.otsPath)[0].status).toBe('pending');
  });

  it('getOtsStatus summarizes receipt states', async () => {
    writeLog([entry(1)]);
    const adapter = createMockOtsAdapter();
    await anchorAndSubmit({ ...paths, adapter });
    await upgradePending({ adapter, otsPath: paths.otsPath });
    const s = getOtsStatus(paths.otsPath);
    expect(s.total).toBe(1);
    expect(s.confirmed).toBe(1);
    expect(s.latest.anchorRoot).toBe(readAnchors(paths.anchorPath)[0].root);
  });
});
