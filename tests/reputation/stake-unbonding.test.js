// §5 残件: ステーク出金のアンボンディング（hit-and-run 防止）テスト。
const { createReputationService } = require('../../src/reputation/reputation-service');

function memRepo() {
  const rows = new Map();
  let seq = 0;
  return {
    getByProviderId: (pid) => [...rows.values()].find((r) => r.providerId === pid) || null,
    create: (row) => { const r = { id: `r${++seq}`, ...row }; rows.set(r.id, r); return r; },
    update: (id, patch) => { const r = { ...rows.get(id), ...patch }; rows.set(id, r); return r; },
  };
}

const T0 = Date.now();
const HOUR = 3600 * 1000;

describe('stake unbonding (§5)', () => {
  it('request creates a pending withdrawal without reducing stake; claim before eligibleAt releases nothing', () => {
    const svc = createReputationService({ repository: memRepo() });
    svc.addStake('p1', 10000);
    const req = svc.requestStakeWithdrawal('p1', 4000, { now: T0, unbondMs: 72 * HOUR });
    expect(req.ok).toBe(true);
    expect(svc.getStats('p1').stake).toBe(10000); // まだ減らない — スラッシュ可能なまま
    const early = svc.claimStakeWithdrawals('p1', { now: T0 + HOUR });
    expect(early.releasedSats).toBe(0);
    expect(svc.getStats('p1').stake).toBe(10000);
  });

  it('claim after unbond releases funds and reduces stake', () => {
    const svc = createReputationService({ repository: memRepo() });
    svc.addStake('p1', 10000);
    svc.requestStakeWithdrawal('p1', 4000, { now: T0 });
    const claim = svc.claimStakeWithdrawals('p1', { now: T0 + 73 * HOUR });
    expect(claim.releasedSats).toBe(4000);
    expect(svc.getStats('p1').stake).toBe(6000);
    expect(svc.getStats('p1').pendingWithdrawals).toEqual([]);
  });

  it('rejects over-withdrawal including existing pending requests', () => {
    const svc = createReputationService({ repository: memRepo() });
    svc.addStake('p1', 10000);
    svc.requestStakeWithdrawal('p1', 6000, { now: T0 });
    const second = svc.requestStakeWithdrawal('p1', 5000, { now: T0 });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('insufficient_stake');
    const bad = svc.requestStakeWithdrawal('p1', -1, { now: T0 });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('invalid_amount');
  });

  it('slash during unbond reduces what a claim releases (hit-and-run prevented)', () => {
    const svc = createReputationService({ repository: memRepo() });
    svc.addStake('p1', 10000);
    svc.requestStakeWithdrawal('p1', 10000, { now: T0 });
    // 猶予中にスラッシュで stake が 10000 → 3000 に目減りしたケースを setStake で再現
    svc.setStake('p1', 3000);
    const claim = svc.claimStakeWithdrawals('p1', { now: T0 + 73 * HOUR });
    expect(claim.requestedSats).toBe(10000);
    expect(claim.releasedSats).toBe(3000); // 残存ステークまでしか出せない
    expect(svc.getStats('p1').stake).toBe(0);
  });
});
