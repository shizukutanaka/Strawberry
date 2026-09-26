// escrow-expiry-poller: deadlineAt 超過 PENDING エスクローの自動期限切れ
const fs = require('fs');
const path = require('path');

const ESCROWS_FILE = path.resolve(__dirname, '../../data/escrows.json');
const AUDIT_FILE = path.resolve(__dirname, '../../data/audit.log');
let backups = {};

function backup() {
  for (const [k, p] of Object.entries({ escrows: ESCROWS_FILE, audit: AUDIT_FILE })) {
    backups[k] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
}
function restore() {
  for (const [k, p] of Object.entries({ escrows: ESCROWS_FILE, audit: AUDIT_FILE })) {
    if (backups[k] === null) { try { fs.unlinkSync(p); } catch (e) {} }
    else fs.writeFileSync(p, backups[k]);
  }
}

const EscrowRepository = require('../../src/db/json/EscrowRepository');
const { createEscrowService } = require('../../src/payments/escrow-service');
const poller = require('../../src/core/escrow-expiry-poller');

describe('escrow-expiry-poller', () => {
  beforeAll(() => { backup(); poller.start(); });
  afterAll(restore);
  beforeEach(() => fs.writeFileSync(ESCROWS_FILE, '[]'));

  test('deadlineAt 超過の PENDING エスクローは CANCELED へ遷移する', () => {
    const svc = createEscrowService({ repository: EscrowRepository });
    const e = svc.create({
      orderId: 'o-overdue', amountSats: 1000,
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const r = poller.pollOnce();
    expect(r.expired).toBe(1);
    expect(EscrowRepository.getById(e.id).state).toBe('CANCELED');
  });

  test('将来 deadlineAt または HELD は期限切れにしない', () => {
    const svc = createEscrowService({ repository: EscrowRepository });
    const future = svc.create({
      orderId: 'o-future', amountSats: 1000,
      deadlineAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const held = svc.create({
      orderId: 'o-held', amountSats: 1000,
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    });
    svc.markPaid(held.id);
    const r = poller.pollOnce();
    expect(r.expired).toBe(0);
    expect(EscrowRepository.getById(future.id).state).toBe('PENDING');
    expect(EscrowRepository.getById(held.id).state).toBe('HELD');
  });

  test('deadlineAt 未設定の PENDING は対象外', () => {
    const svc = createEscrowService({ repository: EscrowRepository });
    const e = svc.create({ orderId: 'o-nodeadline', amountSats: 1000 });
    expect(poller.pollOnce().expired).toBe(0);
    expect(EscrowRepository.getById(e.id).state).toBe('PENDING');
  });
});
