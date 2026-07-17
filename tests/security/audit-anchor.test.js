// tests/security/audit-anchor.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildAuditAnchor,
  proveEntry,
  verifyEntryInclusion,
  anchorAuditLogFile,
  readAnchors,
  parseEntries,
} = require('../../src/security/audit-anchor');

const entries = [
  { timestamp: '2026-06-01T00:00:00Z', action: 'login', detail: { ip: '1.1.1.1' }, user: 'a' },
  { timestamp: '2026-06-01T00:01:00Z', action: 'order', detail: { id: 'o1' }, user: 'b' },
  { timestamp: '2026-06-01T00:02:00Z', action: 'pay', detail: { sats: 1000 }, user: 'c' },
];

describe('audit-anchor', () => {
  it('builds an anchor with root, count, and index range', () => {
    const anchor = buildAuditAnchor(entries, { now: () => '2026-06-09T00:00:00Z' });
    expect(anchor.algorithm).toBe('sha256-merkle-v1');
    expect(anchor.root).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor.count).toBe(3);
    expect(anchor.fromIndex).toBe(0);
    expect(anchor.toIndex).toBe(2);
    expect(anchor.createdAt).toBe('2026-06-09T00:00:00Z');
  });

  it('records fromIndex for incremental anchors', () => {
    const anchor = buildAuditAnchor(entries, { fromIndex: 100 });
    expect(anchor.fromIndex).toBe(100);
    expect(anchor.toIndex).toBe(102);
  });

  it('produces verifiable inclusion proofs for each entry', () => {
    const anchor = buildAuditAnchor(entries);
    for (let i = 0; i < entries.length; i++) {
      const proof = proveEntry(entries, i);
      expect(verifyEntryInclusion(entries[i], proof, anchor.root)).toBe(true);
    }
  });

  it('rejects a tampered entry against the anchored root', () => {
    const anchor = buildAuditAnchor(entries);
    const proof = proveEntry(entries, 1);
    const tampered = { ...entries[1], detail: { id: 'HACKED' } };
    expect(verifyEntryInclusion(tampered, proof, anchor.root)).toBe(false);
  });

  it('changes the root if any entry changes (detects log rewrite)', () => {
    const a1 = buildAuditAnchor(entries).root;
    const rewritten = entries.map((e, i) => (i === 2 ? { ...e, detail: { sats: 9999 } } : e));
    expect(buildAuditAnchor(rewritten).root).not.toBe(a1);
  });

  it('throws on empty entries', () => {
    expect(() => buildAuditAnchor([])).toThrow(/non-empty/);
  });

  it('parseEntries skips blank and corrupt lines', () => {
    const text = JSON.stringify(entries[0]) + '\n\n{ broken json\n' + JSON.stringify(entries[1]) + '\n';
    const parsed = parseEntries(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].action).toBe('order');
  });

  describe('file I/O', () => {
    let dir;
    let logPath;
    let anchorPath;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchor-'));
      logPath = path.join(dir, 'audit.log');
      anchorPath = path.join(dir, 'audit-anchors.jsonl');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('returns null when the log file does not exist', () => {
      expect(anchorAuditLogFile({ logPath, anchorPath })).toBeNull();
    });

    it('returns null for an empty log file', () => {
      fs.writeFileSync(logPath, '\n  \n');
      expect(anchorAuditLogFile({ logPath, anchorPath })).toBeNull();
    });

    it('anchors a real log file and appends to the anchor file', () => {
      fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const anchor = anchorAuditLogFile({ logPath, anchorPath, now: () => '2026-06-09T12:00:00Z' });
      expect(anchor.count).toBe(3);
      expect(anchor.root).toMatch(/^[0-9a-f]{64}$/);

      const stored = readAnchors(anchorPath);
      expect(stored).toHaveLength(1);
      expect(stored[0].root).toBe(anchor.root);
    });

    it('appends a second anchor on a later call (anchor history grows)', () => {
      fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
      anchorAuditLogFile({ logPath, anchorPath });
      fs.appendFileSync(logPath, JSON.stringify({ timestamp: 't', action: 'settle', user: 'd' }) + '\n');
      anchorAuditLogFile({ logPath, anchorPath });

      const stored = readAnchors(anchorPath);
      expect(stored).toHaveLength(2);
      expect(stored[0].count).toBe(3);
      expect(stored[1].count).toBe(4);
      expect(stored[0].root).not.toBe(stored[1].root);
    });

    it('readAnchors returns [] when no anchor file exists', () => {
      expect(readAnchors(anchorPath)).toEqual([]);
    });
  });
});
