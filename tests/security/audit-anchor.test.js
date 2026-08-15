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

  // 増分アンカリング。旧実装は毎回ログ全体を fromIndex=0 で再アンカーしており、
  // 呼ぶたびに範囲の重複したアンカーが増え、50MB 上限のログを毎サイクル全パースしていた。
  describe('anchorNewEntries (incremental)', () => {
    const {
      anchorNewEntries, proveEntryAtIndex, readEntriesFrom, lastAnchor,
    } = require('../../src/security/audit-anchor');

    let dir;
    let logPath;
    let anchorPath;
    const line = (o) => JSON.stringify(o) + '\n';
    const entry = (action, user = 'u') => ({ timestamp: '2026-08-01T00:00:00Z', action, detail: {}, user });

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchor-inc-'));
      logPath = path.join(dir, 'audit.log');
      anchorPath = path.join(dir, 'audit-anchors.jsonl');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('anchors only the entries added since the previous anchor', () => {
      fs.writeFileSync(logPath, line(entry('login')) + line(entry('order')));
      const a1 = anchorNewEntries({ logPath, anchorPath });
      expect(a1.fromIndex).toBe(0);
      expect(a1.toIndex).toBe(1);
      expect(a1.count).toBe(2);
      expect(a1.prevAnchorRoot).toBeNull();

      fs.appendFileSync(logPath, line(entry('pay')) + line(entry('settle')));
      const a2 = anchorNewEntries({ logPath, anchorPath });
      expect(a2.fromIndex).toBe(2);
      expect(a2.toIndex).toBe(3);
      expect(a2.count).toBe(2); // 全4件ではなく新規2件だけ
      // アンカー列を連鎖させ、範囲ごと削除をアンカーファイル単体からも検出できるようにする
      expect(a2.prevAnchorRoot).toBe(a1.root);
    });

    it('returns null when there is nothing new', () => {
      fs.writeFileSync(logPath, line(entry('login')));
      expect(anchorNewEntries({ logPath, anchorPath })).not.toBeNull();
      expect(anchorNewEntries({ logPath, anchorPath })).toBeNull();
    });

    it('does not spin on its own bookkeeping entries', () => {
      // アンカー生成は自身も監査エントリを足す。それだけを理由に次サイクルが走ると
      // 「アンカーを作る→ログが1件増える→またアンカーを作る」が無限に続く。
      fs.writeFileSync(logPath, line(entry('login')));
      anchorNewEntries({ logPath, anchorPath });
      fs.appendFileSync(logPath, line(entry('audit_anchor_created')));
      expect(anchorNewEntries({ logPath, anchorPath })).toBeNull();

      // 実アクティビティが来たら、簿記エントリも含めてまとめてアンカーする
      fs.appendFileSync(logPath, line(entry('pay')));
      const a = anchorNewEntries({ logPath, anchorPath });
      expect(a.fromIndex).toBe(1);
      expect(a.count).toBe(2);
    });

    it('returns null for a missing or empty log', () => {
      expect(anchorNewEntries({ logPath, anchorPath })).toBeNull();
      fs.writeFileSync(logPath, '');
      expect(anchorNewEntries({ logPath, anchorPath })).toBeNull();
    });

    it('resets from index 0 and flags truncation when the log shrinks', () => {
      fs.writeFileSync(logPath, line(entry('a')) + line(entry('b')) + line(entry('c')));
      anchorNewEntries({ logPath, anchorPath });
      // ローテーション/削除/切詰めを模す
      fs.writeFileSync(logPath, line(entry('fresh')));
      const a = anchorNewEntries({ logPath, anchorPath });
      expect(a.fromIndex).toBe(0);
      expect(a.count).toBe(1);
      expect(a.truncationDetected).toBe(true);
    });

    it('does not consume a partially written trailing line', () => {
      // appendFileSync 途中のクラッシュを模す。行を捨てつつオフセットだけ進めると
      // そのエントリは二度とアンカーされず監査証跡に穴が空く。
      fs.writeFileSync(logPath, line(entry('complete')) + '{"timestamp":"t","action":"par');
      const a = anchorNewEntries({ logPath, anchorPath });
      expect(a.count).toBe(1);
      expect(a.toByteOffset).toBe(Buffer.byteLength(line(entry('complete')), 'utf-8'));

      // 残りが書き終わったら、次のサイクルでちゃんと拾える
      fs.writeFileSync(logPath, line(entry('complete')) + line(entry('partial-now-complete')));
      const a2 = anchorNewEntries({ logPath, anchorPath });
      expect(a2.count).toBe(1);
      expect(a2.fromIndex).toBe(1);
    });

    it('readEntriesFrom reports truncation without throwing', () => {
      fs.writeFileSync(logPath, line(entry('a')));
      expect(readEntriesFrom(logPath, 9999)).toEqual({ entries: [], endOffset: 0, truncated: true });
      expect(readEntriesFrom(path.join(dir, 'nope.log'), 0).entries).toEqual([]);
    });

    it('proveEntryAtIndex resolves a global index to the anchor that covers it', () => {
      fs.writeFileSync(logPath, line(entry('a')) + line(entry('b')));
      const a1 = anchorNewEntries({ logPath, anchorPath });
      fs.appendFileSync(logPath, line(entry('c')) + line(entry('d')));
      const a2 = anchorNewEntries({ logPath, anchorPath });

      const p0 = proveEntryAtIndex(0, { logPath, anchorPath });
      expect(p0.anchor.root).toBe(a1.root);
      expect(p0.entry.action).toBe('a');
      expect(verifyEntryInclusion(p0.entry, p0.proof, a1.root)).toBe(true);

      const p3 = proveEntryAtIndex(3, { logPath, anchorPath });
      expect(p3.anchor.root).toBe(a2.root);
      expect(p3.entry.action).toBe('d');
      expect(p3.localIndex).toBe(1);
      expect(verifyEntryInclusion(p3.entry, p3.proof, a2.root)).toBe(true);
    });

    it('proveEntryAtIndex returns null for an index no anchor covers', () => {
      fs.writeFileSync(logPath, line(entry('a')));
      anchorNewEntries({ logPath, anchorPath });
      expect(proveEntryAtIndex(99, { logPath, anchorPath })).toBeNull();
      expect(proveEntryAtIndex(-1, { logPath, anchorPath })).toBeNull();
    });

    it('lastAnchor returns the most recent anchor', () => {
      expect(lastAnchor(anchorPath)).toBeNull();
      fs.writeFileSync(logPath, line(entry('a')));
      const a1 = anchorNewEntries({ logPath, anchorPath });
      expect(lastAnchor(anchorPath).root).toBe(a1.root);
    });
  });

  // パス解決のバグ回帰テスト。旧実装はモジュール読込時に __dirname 固定で
  // AUDIT_LOG_PATH を無視しており、その変数を設定した環境ではアンカラーが
  // 実ログとは別のファイルを見ていた（audit-log.js は呼び出しごとに解決する）。
  describe('path resolution honours AUDIT_LOG_PATH / AUDIT_ANCHOR_PATH', () => {
    const { auditLogPath, anchorFilePath } = require('../../src/security/audit-anchor');
    const saved = { log: process.env.AUDIT_LOG_PATH, anchor: process.env.AUDIT_ANCHOR_PATH };
    afterEach(() => {
      if (saved.log === undefined) delete process.env.AUDIT_LOG_PATH;
      else process.env.AUDIT_LOG_PATH = saved.log;
      if (saved.anchor === undefined) delete process.env.AUDIT_ANCHOR_PATH;
      else process.env.AUDIT_ANCHOR_PATH = saved.anchor;
    });

    it('resolves at call time, matching audit-log.js', () => {
      process.env.AUDIT_LOG_PATH = '/tmp/custom-audit.log';
      process.env.AUDIT_ANCHOR_PATH = '/tmp/custom-anchors.jsonl';
      expect(auditLogPath()).toBe('/tmp/custom-audit.log');
      expect(anchorFilePath()).toBe('/tmp/custom-anchors.jsonl');
    });

    it('falls back to the repo default when unset', () => {
      delete process.env.AUDIT_LOG_PATH;
      expect(auditLogPath()).toMatch(/logs[/\\]audit\.log$/);
    });
  });
});
