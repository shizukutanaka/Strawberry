// tests/api/order-calendar-gate.test.js
// Googleカレンダー連携の環境ゲート回帰テスト。
//
// 背景: google-calendar.js は googleapis（package.json 未収録の optional 依存）を
// 要求するため require が必ず失敗する。旧コードは GCAL_* 未設定でも注文作成の
// たびに require を試みて ERROR ログを吐いていた（本物のエラーが埋もれる）。
// 修正後は GCAL_REFRESH_TOKEN 設定済み環境でのみ読み込みを試みる。

const request = require('supertest');
const { app } = require('../../src/api/server');
const GpuRepository = require('../../src/db/json/GpuRepository');
const UserRepository = require('../../src/db/json/UserRepository');
const { logger } = require('../../src/utils/logger');

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise(done => {
    if (server && server.close) server.close(() => done());
    else done();
  });
});

let _seq = 0;
async function registerAndLogin(prefix, role = 'user') {
  const uniq = `${prefix}${Date.now().toString(36)}${_seq++}`;
  const email = `${uniq}@example.com`;
  const username = uniq.slice(0, 20);
  const password = 'Test1234!';
  await request(app).post('/api/v1/users/register').send({ username, email, password, role });
  const res = await request(app).post('/api/v1/users/login').send({ email, password });
  const u = UserRepository.getByEmail(email);
  return { token: res.body.token, id: u ? u.id : null };
}

async function createOrder(renter, gpuId, offsetSec) {
  return request(app)
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${renter.token}`)
    .send({
      gpuId,
      durationMinutes: 30,
      scheduledStartAt: new Date(Date.now() + offsetSec * 1000).toISOString()
    });
}

describe('Googleカレンダー連携の環境ゲート', () => {
  let provider, renter;
  const SAVED_TOKEN = process.env.GCAL_REFRESH_TOKEN;

  beforeAll(async () => {
    provider = await registerAndLogin('gcgprov', 'provider');
    renter = await registerAndLogin('gcgrnt');
  });

  afterEach(() => {
    if (SAVED_TOKEN === undefined) delete process.env.GCAL_REFRESH_TOKEN;
    else process.env.GCAL_REFRESH_TOKEN = SAVED_TOKEN;
  });

  it('GCAL_REFRESH_TOKEN 未設定: 注文作成でカレンダー関連ログが出ない', async () => {
    delete process.env.GCAL_REFRESH_TOKEN;
    const gpu = GpuRepository.create({
      name: `GPU-GCG-${Date.now()}`, model: 'A100', vendor: 'NVIDIA',
      memoryGB: 80, pricePerHour: 2.0, providerId: provider.id, available: true,
    });
    const errSpy = jest.spyOn(logger, 'error');
    const warnSpy = jest.spyOn(logger, 'warn');
    try {
      const res = await createOrder(renter, gpu.id, 7200);
      expect(res.statusCode).toBe(201);
      const calendarLogs = [...errSpy.mock.calls, ...warnSpy.mock.calls]
        .filter(args => String(args[0]).includes('Google'));
      expect(calendarLogs).toEqual([]);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('GCAL_REFRESH_TOKEN 設定済み: 未導入依存の読込失敗は warn で1度だけ記録', async () => {
    process.env.GCAL_REFRESH_TOKEN = 'dummy-refresh-token';
    const gpu = GpuRepository.create({
      name: `GPU-GCG2-${Date.now()}`, model: 'A100', vendor: 'NVIDIA',
      memoryGB: 80, pricePerHour: 2.0, providerId: provider.id, available: true,
    });
    const warnSpy = jest.spyOn(logger, 'warn');
    const errSpy = jest.spyOn(logger, 'error');
    try {
      const res = await createOrder(renter, gpu.id, 9000);
      expect(res.statusCode).toBe(201);
      // googleapis 未導入なので読込失敗 warn が出るが、error ではない
      const warns = warnSpy.mock.calls.filter(a => String(a[0]).includes('Google'));
      const errs = errSpy.mock.calls.filter(a => String(a[0]).includes('Google'));
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(errs).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
