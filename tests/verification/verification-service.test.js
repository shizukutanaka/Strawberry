// tests/verification/verification-service.test.js
const { createVerificationService } = require('../../src/verification/verification-service');
const { createEscrowService } = require('../../src/payments/escrow-service');
const { STATES } = require('../../src/payments/escrow-state-machine');

function makeMemoryRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    getByJobId: (jobId) => [...rows.values()].find((r) => r.jobId === jobId) || null,
    create: (rec) => {
      const id = `ver-${++seq}`;
      const row = { ...rec, id };
      rows.set(id, row);
      return row;
    },
    update: (id, updates) => {
      const cur = rows.get(id);
      if (!cur) return null;
      const next = { ...cur, ...updates };
      rows.set(id, next);
      return next;
    },
  };
}

const svc = (extra = {}) => createVerificationService({ repository: makeMemoryRepo(), ...extra });

describe('verification-service', () => {
  it('open decides audit flag deterministically and requires jobId', () => {
    const s = svc();
    expect(s.open('job-x', { auditRate: 1 }).audited).toBe(true);
    expect(s.open('job-y', { auditRate: 0 }).audited).toBe(false);
    expect(() => s.open()).toThrow(/jobId/);
  });

  it('non-audited busy job is verified on profiling alone', () => {
    const s = svc();
    s.open('j', { auditRate: 0 });
    s.recordPrimary('j', [1, 2, 3], { utilSamples: [80, 90, 70] });
    const r = s.finalize('j');
    expect(r.verdict).toBe('verified');
    expect(r.verificationCtx).toEqual({ verified: true, suspectedZeroLoad: false });
  });

  it('zero-load suspicion fails regardless of audit', () => {
    const s = svc();
    s.open('j', { auditRate: 0 });
    s.recordPrimary('j', [1, 2, 3], { utilSamples: [0, 0, 1, 0] });
    const r = s.finalize('j');
    expect(r.verdict).toBe('failed');
    expect(r.verificationCtx.suspectedZeroLoad).toBe(true);
  });

  it('audited job with matching replicas reaches consensus -> verified', () => {
    const s = svc();
    s.open('j', { auditRate: 1 });
    s.recordPrimary('j', [1.0, 2.0], { utilSamples: [80, 85] });
    s.submitReplica('j', [1.0001, 2.0]);
    s.submitReplica('j', [0.9999, 2.0001]);
    const r = s.finalize('j', { tolerance: 1e-3 });
    expect(r.verdict).toBe('verified');
  });

  it('audited job with a dishonest replica fails', () => {
    const s = svc();
    s.open('j', { auditRate: 1 });
    s.recordPrimary('j', [1.0, 2.0], { utilSamples: [80, 85] });
    s.submitReplica('j', [9.0, 9.0]); // single mismatching replica -> binary fail
    const r = s.finalize('j');
    expect(r.verdict).toBe('failed');
    expect(r.verificationCtx.verified).toBe(false);
  });

  it('audited job without replicas is inconclusive (escrow should WAIT)', () => {
    const s = svc();
    s.open('j', { auditRate: 1 });
    s.recordPrimary('j', [1, 2], { utilSamples: [80] });
    const r = s.finalize('j');
    expect(r.verdict).toBe('inconclusive');
    expect(r.verificationCtx.verified).toBeNull();
  });

  it('reports audit pass/fail to the reputation service', () => {
    const calls = [];
    const reputationService = { recordAudit: (pid, pass) => calls.push([pid, pass]) };
    const s = svc({ reputationService });
    s.open('j', { providerId: 'prov-1', auditRate: 0 });
    s.recordPrimary('j', [1], { utilSamples: [90] });
    s.finalize('j');
    expect(calls).toEqual([['prov-1', true]]);
  });

  it('integrates with escrow: finalize ctx drives settle/dispute', () => {
    const verification = svc();
    const escrow = createEscrowService({ repository: (function () {
      const rows = new Map(); let n = 0;
      return {
        create: (rec) => { const id = `e-${++n}`; const row = { ...rec, id }; rows.set(id, row); return row; },
        getById: (id) => rows.get(id) || null,
        update: (id, u) => { const c = rows.get(id); if (!c) return null; const x = { ...c, ...u }; rows.set(id, x); return x; },
      };
    })() });

    const e = escrow.create({ orderId: 'o', amountSats: 1000 });
    escrow.markPaid(e.id);

    // honest job -> verified -> escrow settles
    verification.open('job-ok', { auditRate: 0 });
    verification.recordPrimary('job-ok', [1, 2], { utilSamples: [80, 85] });
    const v = verification.finalize('job-ok');
    const settled = escrow.evaluate(e.id, v.verificationCtx);
    expect(settled.escrow.state).toBe(STATES.SETTLED);
  });
});
