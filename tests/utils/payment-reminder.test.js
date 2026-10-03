// src/utils/payment-reminder.js — 支払いリマインダーの送信条件を固定するテスト。
// pending 限定・LINE_TOKEN 未設定での抑止・notifyByLine オプトアウト・
// ユーザー不在スキップ・送信失敗の隔離はスパム防止の中核契約。
jest.mock('../../src/utils/notifier', () => ({
  sendNotification: jest.fn().mockResolvedValue({}),
  NotifyType: { LINE: 'line', WEBHOOK: 'webhook' },
}));

const { sendNotification } = require('../../src/utils/notifier');
const { remindPendingPayments } = require('../../src/utils/payment-reminder');
const PaymentRepository = require('../../src/db/json/PaymentRepository');
const UserRepository = require('../../src/db/json/UserRepository');

const SAVED = {};
function setEnv(k, v) { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; }
function delEnv(k) { if (!(k in SAVED)) SAVED[k] = process.env[k]; delete process.env[k]; }

const created = { users: [], payments: [] };
async function seedUser(extra = {}) {
  const row = await UserRepository.create({ username: `u-${Date.now()}-${Math.random()}`, role: 'user', ...extra });
  created.users.push(row.id);
  return row;
}
async function seedPayment(userId, status) {
  const row = await PaymentRepository.create({ userId, status, orderId: 'o-1', amount: 5000 });
  created.payments.push(row.id);
  return row;
}

beforeEach(() => {
  sendNotification.mockReset().mockResolvedValue({});
  setEnv('LINE_TOKEN', 'line-tok');
});
afterEach(async () => {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    delete SAVED[k];
  }
  for (const id of created.users) { try { await UserRepository.delete(id); } catch {} }
  for (const id of created.payments) { try { await PaymentRepository.delete(id); } catch {} }
  created.users.length = 0;
  created.payments.length = 0;
});

describe('remindPendingPayments', () => {
  it('notifies only pending payments (paid/failed skipped)', async () => {
    const u = await seedUser();
    await seedPayment(u.id, 'pending');
    await seedPayment(u.id, 'paid');
    await seedPayment(u.id, 'failed');
    await remindPendingPayments();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when LINE_TOKEN is unset', async () => {
    const u = await seedUser();
    await seedPayment(u.id, 'pending');
    delEnv('LINE_TOKEN');
    await remindPendingPayments();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('skips users who opted out via notifyByLine=false, others still notified', async () => {
    const optOut = await seedUser({ notifyByLine: false });
    const normal = await seedUser();
    await seedPayment(optOut.id, 'pending');
    await seedPayment(normal.id, 'pending');
    await remindPendingPayments();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('skips payments whose user no longer exists', async () => {
    await seedPayment('ghost-user', 'pending');
    await remindPendingPayments();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('includes orderId and amount in the message', async () => {
    const u = await seedUser();
    await seedPayment(u.id, 'pending');
    await remindPendingPayments();
    const [, msg] = sendNotification.mock.calls[0];
    expect(msg).toContain('o-1');
    expect(msg).toContain('5000');
    expect(sendNotification.mock.calls[0][0]).toBe('line');
    expect(sendNotification.mock.calls[0][2]).toEqual({ token: 'line-tok' });
  });

  it('isolates per-payment send failures (one bad send does not block the rest)', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    await seedPayment(u1.id, 'pending');
    await seedPayment(u2.id, 'pending');
    sendNotification.mockRejectedValueOnce(new Error('line down'));
    await remindPendingPayments();
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });
});
