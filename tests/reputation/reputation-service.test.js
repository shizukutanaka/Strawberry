// tests/reputation/reputation-service.test.js
const { createReputationService } = require('../../src/reputation/reputation-service');

function makeMemoryRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    getByProviderId: (pid) => [...rows.values()].find((r) => r.providerId === pid) || null,
    create: (rec) => {
      const id = `rep-${++seq}`;
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

const svc = () => createReputationService({ repository: makeMemoryRepo() });

describe('reputation-service', () => {
  it('auto-creates a provider with default stats on first event', () => {
    const s = svc();
    s.recordJobResult('p1', true);
    expect(s.getStats('p1').completedJobs).toBe(1);
    expect(s.getStats('p1').failedJobs).toBe(0);
  });

  it('requires providerId', () => {
    expect(() => svc().recordJobResult(undefined, true)).toThrow(/providerId/);
  });

  it('accumulates job and audit results', () => {
    const s = svc();
    s.recordJobResult('p', true);
    s.recordJobResult('p', true);
    s.recordJobResult('p', false);
    s.recordAudit('p', true);
    s.recordAudit('p', false);
    const st = s.getStats('p');
    expect(st.completedJobs).toBe(2);
    expect(st.failedJobs).toBe(1);
    expect(st.auditPasses).toBe(1);
    expect(st.auditFails).toBe(1);
  });

  it('slashing lowers the score', () => {
    const s = svc();
    for (let i = 0; i < 50; i++) s.recordJobResult('p', true);
    s.addStake('p', 2_000_000);
    const before = s.getScore('p').score;
    s.slash('p');
    const after = s.getScore('p').score;
    expect(after).toBeLessThan(before);
  });

  it('adding stake raises the score', () => {
    const s = svc();
    for (let i = 0; i < 50; i++) s.recordJobResult('p', true);
    const before = s.getScore('p').score;
    s.addStake('p', 5_000_000);
    const after = s.getScore('p').score;
    expect(after).toBeGreaterThan(before);
  });

  it('setSla updates reliability inputs', () => {
    const s = svc();
    for (let i = 0; i < 50; i++) s.recordJobResult('p', true);
    s.addStake('p', 1_000_000);
    const stable = s.getScore('p').score;
    s.setSla('p', { interruptionRate: 0.5 });
    const flaky = s.getScore('p').score;
    expect(flaky).toBeLessThan(stable);
  });

  it('getScore on unknown provider returns a baseline (no crash)', () => {
    const r = svc().getScore('ghost');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('rank orders known providers by score and throws on non-array', () => {
    const s = svc();
    for (let i = 0; i < 100; i++) s.recordJobResult('strong', true);
    s.addStake('strong', 5_000_000);
    s.recordJobResult('weak', false);
    s.recordJobResult('weak', false);
    const ranked = s.rank(['weak', 'strong']);
    expect(ranked[0].id).toBe('strong');
    expect(() => s.rank('nope')).toThrow();
  });
});
