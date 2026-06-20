// tests/payments/escrow-state-machine.test.js
const {
  STATES, isTerminal, initial, transition, tryTransition, decideSettlement, applyDecision,
} = require('../../src/payments/escrow-state-machine');

describe('escrow-state-machine: transitions', () => {
  it('starts PENDING and is not terminal', () => {
    expect(initial()).toBe(STATES.PENDING);
    expect(isTerminal(STATES.PENDING)).toBe(false);
    expect(isTerminal(STATES.SETTLED)).toBe(true);
    expect(isTerminal(STATES.CANCELED)).toBe(true);
  });

  it('happy path: PENDING -PAY-> HELD -DELIVER_OK-> SETTLED reveals preimage', () => {
    const held = transition(STATES.PENDING, 'PAY');
    expect(held.state).toBe(STATES.HELD);
    expect(held.actions).toContain('hold_preimage');

    const settled = transition(STATES.HELD, 'DELIVER_OK');
    expect(settled.state).toBe(STATES.SETTLED);
    expect(settled.actions).toEqual(expect.arrayContaining(['reveal_preimage', 'payout_provider', 'collect_fee']));
  });

  it('failed delivery moves HELD -> DISPUTED (preimage withheld)', () => {
    const d = transition(STATES.HELD, 'DELIVER_FAIL');
    expect(d.state).toBe(STATES.DISPUTED);
    expect(d.actions).toContain('open_dispute');
    expect(d.actions).not.toContain('reveal_preimage');
  });

  it('dispute can resolve to refund + slash, or to settle', () => {
    const refunded = transition(STATES.DISPUTED, 'RESOLVE_REFUND');
    expect(refunded.state).toBe(STATES.CANCELED);
    expect(refunded.actions).toEqual(expect.arrayContaining(['refund_renter', 'slash_provider']));

    const settled = transition(STATES.DISPUTED, 'RESOLVE_SETTLE');
    expect(settled.state).toBe(STATES.SETTLED);
    expect(settled.actions).toContain('reveal_preimage');
  });

  it('unpaid PENDING that hits DEADLINE cancels (HTLC expiry refunds)', () => {
    expect(transition(STATES.PENDING, 'DEADLINE').state).toBe(STATES.CANCELED);
  });

  it('HELD without a verdict at DEADLINE goes to DISPUTED', () => {
    expect(transition(STATES.HELD, 'DEADLINE').state).toBe(STATES.DISPUTED);
  });

  it('rejects invalid transitions and unknown states', () => {
    expect(() => transition(STATES.SETTLED, 'PAY')).toThrow(/invalid transition/);
    expect(() => transition(STATES.PENDING, 'DELIVER_OK')).toThrow(/invalid transition/);
    expect(() => transition('NOPE', 'PAY')).toThrow(/unknown escrow state/);
  });

  it('returns a fresh actions array (no shared mutation)', () => {
    const a = transition(STATES.PENDING, 'PAY');
    a.actions.push('mutated');
    const b = transition(STATES.PENDING, 'PAY');
    expect(b.actions).not.toContain('mutated');
  });

  it('DISPUTED has a DEADLINE exit (refund the renter) so it cannot deadlock', () => {
    const t = transition(STATES.DISPUTED, 'DEADLINE');
    expect(t.state).toBe(STATES.CANCELED);
    expect(t.actions).toContain('refund_renter');
  });
});

describe('escrow-state-machine: tryTransition (non-throwing)', () => {
  it('returns ok:true with state/actions for a legal transition', () => {
    const r = tryTransition(STATES.HELD, 'DELIVER_OK');
    expect(r.ok).toBe(true);
    expect(r.state).toBe(STATES.SETTLED);
    expect(Array.isArray(r.actions)).toBe(true);
  });

  it('returns ok:false instead of throwing on illegal/unknown', () => {
    expect(tryTransition(STATES.PENDING, 'DELIVER_OK')).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(tryTransition(STATES.SETTLED, 'PAY')).toEqual({ ok: false, reason: 'terminal_state' });
    expect(tryTransition('NOPE', 'PAY')).toEqual({ ok: false, reason: 'unknown_state' });
  });
});

describe('escrow-state-machine: decideSettlement', () => {
  it('settles when verified, fails on zero-load or verification failure', () => {
    expect(decideSettlement({ verified: true })).toBe('DELIVER_OK');
    expect(decideSettlement({ verified: false })).toBe('DELIVER_FAIL');
    expect(decideSettlement({ verified: null, suspectedZeroLoad: true })).toBe('DELIVER_FAIL');
  });

  it('waits while undecided and not past deadline', () => {
    expect(decideSettlement({ verified: null, deadlinePassed: false })).toBe('WAIT');
  });

  it('on deadline, settles if delivered enough else fails', () => {
    expect(decideSettlement({ deadlinePassed: true, deliveredRatio: 0.95 })).toBe('DELIVER_OK');
    expect(decideSettlement({ deadlinePassed: true, deliveredRatio: 0.3 })).toBe('DELIVER_FAIL');
  });

  it('applyDecision is a no-op on WAIT and drives the FSM otherwise', () => {
    const wait = applyDecision(STATES.HELD, { verified: null, deadlinePassed: false });
    expect(wait.state).toBe(STATES.HELD);
    expect(wait.event).toBe('WAIT');

    const ok = applyDecision(STATES.HELD, { verified: true });
    expect(ok.state).toBe(STATES.SETTLED);
    expect(ok.event).toBe('DELIVER_OK');
  });
});
