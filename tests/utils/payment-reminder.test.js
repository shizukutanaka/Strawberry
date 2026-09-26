// payment-reminder: 期限切れ/新規作成/クールダウンの除外ロジック
const path = require('path');
const fs = require('fs');
const { getPendingPayments } = require('../../src/utils/payment-reminder');
const PaymentRepository = require('../../src/db/json/PaymentRepository');

const PAYMENTS_FILE = path.resolve(__dirname, '../../data/payments.json');
let original = null;
let hadOriginal = false;

function writePayments(rows) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(rows));
}

beforeEach(() => {
  hadOriginal = fs.existsSync(PAYMENTS_FILE);
  original = hadOriginal ? fs.readFileSync(PAYMENTS_FILE, 'utf-8') : null;
});

afterEach(() => {
  if (hadOriginal) fs.writeFileSync(PAYMENTS_FILE, original);
  else try { fs.unlinkSync(PAYMENTS_FILE); } catch (_) {}
});

const now = new Date('2026-09-26T12:00:00Z');
const oldEnough = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30min前
const futureExpiry = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

describe('getPendingPayments', () => {
  const base = { id: 'p1', userId: 'u1', status: 'pending', amount: 100, createdAt: oldEnough, invoiceExpiresAt: futureExpiry };

  it('条件を満たす pending 支払いを返す', () => {
    writePayments([base]);
    expect(getPendingPayments(now).map(p => p.id)).toEqual(['p1']);
  });

  it('pending 以外・期限切れ・作成直後は除外する', () => {
    writePayments([
      { ...base, id: 'paid', status: 'paid' },
      { ...base, id: 'expired', invoiceExpiresAt: new Date(now.getTime() - 1000).toISOString() },
      { ...base, id: 'fresh', createdAt: new Date(now.getTime() - 60 * 1000).toISOString() },
      base,
    ]);
    expect(getPendingPayments(now).map(p => p.id)).toEqual(['p1']);
  });

  it('クールダウン内の lastRemindedAt は除外し、超過すれば再送対象になる', () => {
    const recent = { ...base, id: 'recent', lastRemindedAt: new Date(now.getTime() - 60 * 1000).toISOString() };
    const stale = { ...base, id: 'stale', lastRemindedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() };
    writePayments([recent, stale]);
    expect(getPendingPayments(now).map(p => p.id)).toEqual(['stale']);
  });
});
