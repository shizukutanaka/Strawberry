// tests/marketplace/marketplace-service.test.js
const { createMarketplaceService } = require('../../src/marketplace/marketplace-service');
const { createVerificationService } = require('../../src/verification/verification-service');
const { createReputationService } = require('../../src/reputation/reputation-service');

// 汎用インメモリ repo（id 採番 + keyField 検索）
function memRepo(keyField) {
  const rows = new Map();
  let n = 0;
  return {
    create: (rec) => { const id = `${keyField}-${++n}`; const row = { ...rec, id }; rows.set(id, row); return row; },
    getById: (id) => rows.get(id) || null,
    update: (id, u) => { const c = rows.get(id); if (!c) return null; const x = { ...c, ...u }; rows.set(id, x); return x; },
    [keyField === 'job' ? 'getByJobId' : keyField === 'prov' ? 'getByProviderId' : 'getByOrderId']:
      (val) => [...rows.values()].find((r) => r[keyField === 'job' ? 'jobId' : keyField === 'prov' ? 'providerId' : 'orderId'] === val) || null,
  };
}

function build() {
  const verificationService = createVerificationService({ repository: memRepo('job') });
  const reputationService = createReputationService({ repository: memRepo('prov') });
  const mkt = createMarketplaceService({ verificationService, reputationService });
  return { mkt, reputationService };
}

const GPU = { vramGB: 80, memBandwidthGBs: 3350, benchmarkScore: 300, generation: 'hopper' };

describe('marketplace-service', () => {
  it('requires all sub-services', () => {
    expect(() => createMarketplaceService({})).toThrow(/required/);
  });

  it('quotes price from GPU features and market state', () => {
    const { mkt } = build();
    const q = mkt.quoteGpu(GPU, { utilization: 0.5 });
    expect(q.pricePerHour).toBeGreaterThan(0);
  });

  it('verifyJob: honest job -> verified verdict + reputation credit', () => {
    const { mkt, reputationService } = build();
    const res = mkt.verifyJob({
      jobId: 'job1', providerId: 'p1',
      primaryOutput: [1, 2, 3], utilSamples: [80, 90, 85], auditRate: 0,
    });
    expect(res.verdict).toBe('verified');
    expect(reputationService.getStats('p1').completedJobs).toBe(1);
  });

  it('verifyJob: zero-load job -> failed verdict + reputation failure', () => {
    const { mkt, reputationService } = build();
    const res = mkt.verifyJob({
      jobId: 'job2', providerId: 'bad',
      primaryOutput: [1], utilSamples: [0, 0, 0, 1], auditRate: 0,
    });
    expect(res.verdict).toBe('failed');
    expect(reputationService.getStats('bad').failedJobs).toBe(1);
  });

  it('verifyJob: audited job without replicas -> inconclusive, no job result recorded', () => {
    const { mkt, reputationService } = build();
    const res = mkt.verifyJob({
      jobId: 'job3', providerId: 'p1',
      primaryOutput: [1, 2, 3], utilSamples: [80, 90], auditRate: 1,
    });
    expect(res.verdict).toBe('inconclusive');
    const stats = reputationService.getStats('p1');
    expect(stats.completedJobs).toBe(0);
    expect(stats.failedJobs).toBe(0);
  });

  it('ranks candidates by reputation', () => {
    const { mkt, reputationService } = build();
    for (let i = 0; i < 100; i++) reputationService.recordJobResult('strong', true);
    reputationService.addStake('strong', 5_000_000);
    reputationService.recordJobResult('weak', false);
    const ranked = mkt.rankCandidates(['weak', 'strong']);
    expect(ranked[0].id).toBe('strong');
  });

  it('selectProvider runs a reverse auction, auto-filling reputation from the service', () => {
    const { mkt, reputationService } = build();
    // strong provider: many successes + stake; weak: a failure
    for (let i = 0; i < 100; i++) reputationService.recordJobResult('strong', true);
    reputationService.addStake('strong', 5_000_000);
    reputationService.recordJobResult('weak', false);

    // weak bids slightly cheaper but should lose under balanced weights
    const { winner, ranked, rejected } = mkt.selectProvider([
      { providerId: 'strong', pricePerHour: 160, slaUptimePct: 100 },
      { providerId: 'weak', pricePerHour: 150, slaUptimePct: 95 },
    ]);
    expect(winner.providerId).toBe('strong');
    expect(ranked).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    // reputation was auto-filled (not provided in the bids)
    expect(ranked.find((r) => r.providerId === 'strong').components.reputation).toBeGreaterThan(
      ranked.find((r) => r.providerId === 'weak').components.reputation,
    );
  });
});
