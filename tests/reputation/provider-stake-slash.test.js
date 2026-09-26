// §5: 担保ステーク没収（slash → stake 減算）と検証不一致スラッシングの単体テスト。
const { createReputationService } = require('../../src/reputation/reputation-service');
const { createVerificationService } = require('../../src/verification/verification-service');

function makeRepRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    getByProviderId: (id) => [...rows.values()].find(r => r.providerId === id) || null,
    create: (r) => { const row = { id: `rep-${++seq}`, ...r }; rows.set(row.id, row); return row; },
    update: (id, u) => { const c = rows.get(id); if (!c) return null; const n = { ...c, ...u }; rows.set(id, n); return n; },
  };
}
function makeVerifRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    getByJobId: (j) => [...rows.values()].find(r => r.jobId === j) || null,
    create: (r) => { const row = { id: `v-${++seq}`, ...r }; rows.set(row.id, row); return row; },
    update: (id, u) => { const c = rows.get(id); const n = { ...c, ...u }; rows.set(id, n); return n; },
  };
}

describe('provider stake slashing (§5)', () => {
  afterEach(() => { delete process.env.PROVIDER_SLASH_PENALTY_SATS; });

  it('slash burns stake by penaltySats and tracks cumulative slashedSats', () => {
    const rep = createReputationService({ repository: makeRepRepo() });
    rep.addStake('prov-1', 100000);
    rep.slash('prov-1', 1, 30000);
    const s = rep.getStats('prov-1');
    expect(s.stake).toBe(70000);
    expect(s.slashedSats).toBe(30000);
    expect(s.slashCount).toBe(1);
  });

  it('slash uses PROVIDER_SLASH_PENALTY_SATS when no explicit penalty is given', () => {
    process.env.PROVIDER_SLASH_PENALTY_SATS = '50000';
    const rep = createReputationService({ repository: makeRepRepo() });
    rep.addStake('prov-1', 80000);
    rep.slash('prov-1');
    expect(rep.getStats('prov-1').stake).toBe(30000);
  });

  it('stake never goes negative when penalty exceeds balance', () => {
    const rep = createReputationService({ repository: makeRepRepo() });
    rep.addStake('prov-1', 1000);
    rep.slash('prov-1', 1, 50000);
    const s = rep.getStats('prov-1');
    expect(s.stake).toBe(0);
    expect(s.slashedSats).toBe(50000);
  });

  it('verification "failed" verdict slashes the provider', () => {
    const rep = createReputationService({ repository: makeRepRepo() });
    rep.addStake('prov-2', 10000);
    const svc = createVerificationService({ repository: makeVerifRepo(), reputationService: rep });
    // auditRate:1 で確実に再実行監査を走らせ、replica 不一致で failed にする
    svc.open('job-1', { providerId: 'prov-2', escrowId: 'e1', auditRate: 1 });
    svc.recordPrimary('job-1', [1.0, 0.5]);
    svc.submitReplica('job-1', [9.9, 0.1]);
    const { verdict } = svc.finalize('job-1');
    expect(verdict).toBe('failed');
    const s = rep.getStats('prov-2');
    expect(s.auditFails).toBe(1);
    expect(s.slashCount).toBe(1);
  });

  it('verification "verified" verdict does not slash', () => {
    const rep = createReputationService({ repository: makeRepRepo() });
    const svc = createVerificationService({ repository: makeVerifRepo(), reputationService: rep });
    svc.open('job-2', { providerId: 'prov-3', escrowId: 'e2', auditRate: 1 });
    svc.recordPrimary('job-2', [0.5, 0.7]);
    svc.submitReplica('job-2', [0.5, 0.7]);
    const { verdict } = svc.finalize('job-2');
    expect(verdict).toBe('verified');
    expect(rep.getStats('prov-3').slashCount).toBe(0);
  });
});
