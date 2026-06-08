// tests/marketplace/auction-engine.test.js
const { runAuction, scoreBid, priceBounds, DEFAULT_WEIGHTS } = require('../../src/marketplace/auction-engine');

const bids = [
  { providerId: 'cheap-bad', pricePerHour: 100, reputationScore: 0.2, slaUptimePct: 90, attestationScore: 0 },
  { providerId: 'mid', pricePerHour: 150, reputationScore: 0.7, slaUptimePct: 99, attestationScore: 0.8 },
  { providerId: 'pricey-great', pricePerHour: 220, reputationScore: 0.95, slaUptimePct: 100, attestationScore: 1 },
];

describe('auction-engine', () => {
  it('selects a winner balancing price and reputation (not purely cheapest)', () => {
    const { winner, ranked } = runAuction(bids);
    expect(ranked).toHaveLength(3);
    // cheapest-but-worst should not win under default weights
    expect(winner.providerId).not.toBe('cheap-bad');
    // ranked is sorted descending by score
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
  });

  it('purely price-weighted auction picks the cheapest', () => {
    const { winner } = runAuction(bids, { weights: { price: 1, reputation: 0, sla: 0, attestation: 0 } });
    expect(winner.providerId).toBe('cheap-bad');
  });

  it('purely reputation-weighted auction picks the highest reputation', () => {
    const { winner } = runAuction(bids, { weights: { price: 0, reputation: 1, sla: 0, attestation: 0 } });
    expect(winner.providerId).toBe('pricey-great');
  });

  it('rejects bids above the reserve price', () => {
    const { ranked, rejected, winner } = runAuction(bids, { reservePrice: 160 });
    expect(ranked.map((r) => r.providerId).sort()).toEqual(['cheap-bad', 'mid']);
    expect(rejected.find((r) => r.providerId === 'pricey-great').reasons).toContain('over reserve price');
    expect(winner.providerId).not.toBe('pricey-great');
  });

  it('rejects bids below the minimum reputation', () => {
    const { ranked, rejected } = runAuction(bids, { minReputation: 0.5 });
    expect(ranked.map((r) => r.providerId).sort()).toEqual(['mid', 'pricey-great']);
    expect(rejected.find((r) => r.providerId === 'cheap-bad').reasons).toContain('below min reputation');
  });

  it('requireAttestation excludes bids without a passed attestation', () => {
    const withFlags = [
      { providerId: 'a', pricePerHour: 100, reputationScore: 0.8, attestationPassed: true },
      { providerId: 'b', pricePerHour: 110, reputationScore: 0.9, attestationPassed: false },
    ];
    const { ranked, rejected } = runAuction(withFlags, { requireAttestation: true });
    expect(ranked.map((r) => r.providerId)).toEqual(['a']);
    expect(rejected.find((r) => r.providerId === 'b').reasons).toContain('attestation required');
  });

  it('honors explicit eligible:false', () => {
    const withFlags = [
      { providerId: 'a', pricePerHour: 100, reputationScore: 0.8 },
      { providerId: 'b', pricePerHour: 90, reputationScore: 0.8, eligible: false },
    ];
    const { winner, rejected } = runAuction(withFlags);
    expect(winner.providerId).toBe('a');
    expect(rejected.find((r) => r.providerId === 'b').reasons).toContain('marked ineligible');
  });

  it('breaks score ties by choosing the cheaper bid', () => {
    const tied = [
      { providerId: 'x', pricePerHour: 200, reputationScore: 0.5, slaUptimePct: 100 },
      { providerId: 'y', pricePerHour: 100, reputationScore: 0.5, slaUptimePct: 100 },
    ];
    // identical reputation/sla; price differs → cheaper has higher priceScore so y wins anyway,
    // but force a pure-reputation weighting to make scores equal, then tie-break by price
    const { winner } = runAuction(tied, { weights: { price: 0, reputation: 1, sla: 0, attestation: 0 } });
    expect(winner.providerId).toBe('y');
  });

  it('returns null winner and empty ranked when all bids are rejected', () => {
    const { winner, ranked, rejected } = runAuction(bids, { reservePrice: 1 });
    expect(winner).toBeNull();
    expect(ranked).toHaveLength(0);
    expect(rejected).toHaveLength(3);
  });

  it('handles a single bid (price normalizes to full marks)', () => {
    const { winner, ranked } = runAuction([{ providerId: 'solo', pricePerHour: 130, reputationScore: 0.6, slaUptimePct: 100 }]);
    expect(winner.providerId).toBe('solo');
    expect(ranked[0].components.priceScore).toBe(1);
  });

  it('normalizes weights that do not sum to 1', () => {
    const a = runAuction(bids, { weights: { price: 45, reputation: 35, sla: 10, attestation: 10 } });
    const b = runAuction(bids, { weights: DEFAULT_WEIGHTS });
    expect(a.winner.providerId).toBe(b.winner.providerId);
  });

  it('throws on non-array bids', () => {
    expect(() => runAuction('nope')).toThrow(/array/);
  });

  it('priceBounds and scoreBid are exported pure helpers', () => {
    const bounds = priceBounds(bids);
    expect(bounds).toEqual({ min: 100, max: 220 });
    const { score, components } = scoreBid(bids[0], bounds, DEFAULT_WEIGHTS);
    expect(components.priceScore).toBe(1); // cheapest → full price score
    expect(score).toBeGreaterThan(0);
  });
});
