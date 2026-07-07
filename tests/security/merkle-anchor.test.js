// tests/security/merkle-anchor.test.js
const { merkleRoot, merkleProof, verifyProof, buildAnchor } = require('../../src/security/merkle-anchor');

const entries = [
  { action: 'login', user: 'a', at: 1 },
  { action: 'order', user: 'b', at: 2 },
  { action: 'pay', user: 'c', at: 3 },
  { action: 'settle', user: 'd', at: 4 },
  { action: 'slash', user: 'e', at: 5 }, // 5 = 奇数で末尾複製パスを通す
];

describe('merkle-anchor', () => {
  it('produces a deterministic root that changes when any entry changes', () => {
    const r1 = merkleRoot(entries);
    expect(r1).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(entries)).toBe(r1);

    const tampered = entries.map((e, i) => (i === 2 ? { ...e, user: 'HACKED' } : e));
    expect(merkleRoot(tampered)).not.toBe(r1);
  });

  it('verifies an inclusion proof for every index (incl. odd counts)', () => {
    const root = merkleRoot(entries);
    for (let i = 0; i < entries.length; i++) {
      const proof = merkleProof(entries, i);
      expect(verifyProof(entries[i], proof, root)).toBe(true);
    }
  });

  it('rejects a tampered leaf or wrong root', () => {
    const root = merkleRoot(entries);
    const proof = merkleProof(entries, 1);
    expect(verifyProof({ ...entries[1], user: 'X' }, proof, root)).toBe(false);
    expect(verifyProof(entries[1], proof, 'deadbeef')).toBe(false);
  });

  it('handles a single-entry log', () => {
    const single = [{ action: 'boot', at: 0 }];
    const root = merkleRoot(single);
    expect(verifyProof(single[0], merkleProof(single, 0), root)).toBe(true);
  });

  it('buildAnchor returns an OpenTimestamps-ready digest', () => {
    const anchor = buildAnchor(entries, { now: () => '2026-06-06T00:00:00Z' });
    expect(anchor).toEqual({
      algorithm: 'sha256-merkle-v1',
      root: merkleRoot(entries),
      count: 5,
      createdAt: '2026-06-06T00:00:00Z',
    });
  });

  it('throws on empty input and out-of-range index', () => {
    expect(() => merkleRoot([])).toThrow();
    expect(() => merkleProof(entries, 99)).toThrow(/range/);
  });
});
