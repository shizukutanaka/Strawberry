// §3: 部分決済（tx2失敗）自動リトライキューの単体テスト。
// インメモリリポジトリで EscrowRepository の updateIf 契約（{ok,row}）を再現。
const settlementRetry = require('../../src/payments/settlement-retry');

function makeEscrowRepo(rows = []) {
  const map = new Map(rows.map(r => [r.id, r]));
  return {
    _map: map,
    getById: (id) => map.get(id) || null,
    getAll: () => [...map.values()],
    update: (id, u) => { const c = map.get(id); if (!c) return null; const n = { ...c, ...u }; map.set(id, n); return n; },
    updateIf: (id, pred, u) => {
      const c = map.get(id);
      if (!c) return { ok: false, reason: 'not_found' };
      if (!pred(c)) return { ok: false, reason: 'condition_failed', current: c };
      const n = { ...c, ...u }; map.set(id, n);
      return { ok: true, row: n };
    },
    create: (r) => { const row = { id: `esc-${map.size + 1}`, ...r }; map.set(row.id, row); return row; },
  };
}
const makePayRepo = () => ({ rows: [], getByOrderId: function (o) { return this.rows.filter(p => p.orderId === o); }, create: function (r) { this.rows.push({ id: `p${this.rows.length + 1}`, ...r }); } });
const makeOrdRepo = () => ({ getById: (id) => ({ id, userId: 'renter-1', totalPrice: 0.0001 }) });

function heldEscrow(repo, extra = {}) {
  return repo.create({
    orderId: 'ord-1', state: 'HELD', txBorrowerToOperator: 'tx1-abc', total: 1, payout: 0.9,
    ...extra,
  });
}
const PAYLOAD = { orderId: 'ord-1', operatorWallet: 'op', lenderWallet: 'lnd', payout: 0.9, total: 1 };

describe('settlement-retry queue (§3)', () => {
  it('enqueue marks a HELD escrow with a pending retry entry', () => {
    const repo = makeEscrowRepo();
    const esc = heldEscrow(repo);
    const res = settlementRetry.enqueue(esc.id, { ...PAYLOAD, error: 'ln down' }, repo);
    expect(res.ok).toBe(true);
    const e = repo.getById(esc.id);
    expect(e.settlementRetry.status).toBe('pending');
    expect(e.settlementPayload.lenderWallet).toBe('lnd');
  });

  it('does not enqueue when tx2 already completed or state is not HELD', () => {
    const repo = makeEscrowRepo();
    const done = heldEscrow(repo, { state: 'SETTLED', txOperatorToLender: 'tx2-x' });
    expect(settlementRetry.enqueue(done.id, PAYLOAD, repo).ok).toBe(false);
  });

  it('retries only after nextAttemptAt and settles HELD→SETTLED with paid record', async () => {
    const repo = makeEscrowRepo();
    const payRepo = makePayRepo();
    const esc = heldEscrow(repo);
    settlementRetry.enqueue(esc.id, { ...PAYLOAD, error: 'x' }, repo);

    // 期限前はスキャン対象外
    expect(settlementRetry.dueRetries(Date.now(), repo)).toHaveLength(0);

    const sendBTC = jest.fn(async () => ({ txid: 'tx2-recovered' }));
    const out = await settlementRetry.pollOnce({ sendBTC, repository: repo, paymentRepository: payRepo, orderRepository: makeOrdRepo(), now: Date.now() + 60000 });
    expect(out.scanned).toBe(1);
    expect(out.results[0].ok).toBe(true);
    const e = repo.getById(esc.id);
    expect(e.state).toBe('SETTLED');
    expect(e.txOperatorToLender).toBe('tx2-recovered');
    expect(e.settlementRetry.status).toBe('succeeded');
    expect(sendBTC).toHaveBeenCalledWith('op', 'lnd', 0.9);
    expect(payRepo.getByOrderId('ord-1').some(p => p.status === 'paid')).toBe(true);
  });

  it('backs off on failure and goes dead after MAX_ATTEMPTS', async () => {
    const repo = makeEscrowRepo();
    const esc = heldEscrow(repo);
    settlementRetry.enqueue(esc.id, { ...PAYLOAD, error: 'x' }, repo);
    const sendBTC = jest.fn(async () => { throw new Error('still down'); });

    const r1 = await settlementRetry.retryOne(esc.id, { sendBTC, repository: repo });
    expect(r1.ok).toBe(false);
    let e = repo.getById(esc.id);
    expect(e.settlementRetry.attempts).toBe(1);
    expect(e.settlementRetry.status).toBe('pending');
    expect(e.settlementRetry.inFlight).toBe(false);
    expect(Date.parse(e.settlementRetry.nextAttemptAt)).toBeGreaterThan(Date.now());

    // 上限まで枯渇させる
    for (let i = 1; i < settlementRetry.MAX_ATTEMPTS; i++) {
      await settlementRetry.retryOne(esc.id, { sendBTC, repository: repo });
    }
    e = repo.getById(esc.id);
    expect(e.settlementRetry.status).toBe('dead');
    expect(e.state).toBe('HELD'); // 資金滞留のまま — 人手照合対象
    expect(e.txOperatorToLender).toBeUndefined();
  });

  it('in-flight claim prevents double tx2 execution', async () => {
    const repo = makeEscrowRepo();
    const esc = heldEscrow(repo);
    settlementRetry.enqueue(esc.id, { ...PAYLOAD, error: 'x' }, repo);
    // 別プロセスが既にクレーム済みの状態を再現
    repo.update(esc.id, { settlementRetry: { ...repo.getById(esc.id).settlementRetry, inFlight: true } });
    const sendBTC = jest.fn(async () => ({ txid: 'tx2-y' }));
    const res = await settlementRetry.retryOne(esc.id, { sendBTC, repository: repo });
    expect(res.retried).toBe(false);
    expect(sendBTC).not.toHaveBeenCalled();
  });

  it('forceRetry runs immediately regardless of backoff', async () => {
    const repo = makeEscrowRepo();
    const esc = heldEscrow(repo);
    settlementRetry.enqueue(esc.id, { ...PAYLOAD, error: 'x' }, repo);
    const sendBTC = jest.fn(async () => ({ txid: 'tx2-forced' }));
    const res = await settlementRetry.forceRetry(esc.id, { sendBTC, repository: repo, paymentRepository: makePayRepo(), orderRepository: makeOrdRepo() });
    expect(res.ok).toBe(true);
    expect(repo.getById(esc.id).state).toBe('SETTLED');
  });

  it('list exposes pending and dead entries for the admin endpoint', () => {
    const repo = makeEscrowRepo();
    const a = heldEscrow(repo);
    heldEscrow(repo); // キュー外
    settlementRetry.enqueue(a.id, { ...PAYLOAD, error: 'x' }, repo);
    const items = settlementRetry.list(repo);
    expect(items).toHaveLength(1);
    expect(items[0].escrowId).toBe(a.id);
  });
});
