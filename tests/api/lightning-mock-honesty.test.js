// tests/api/lightning-mock-honesty.test.js
// 実 LND が無いときに「支払える請求書がある」と装わないこと。
//
// きっかけ: 起動ログに毎回
//   LND接続失敗 ENOENT: no such file or directory, open '/home/proto/lightning.proto'
// が出ていた。調べると二重の問題があった。
//
//  1. パスが壊れていた。lightning-service.js はリポジトリ直下にあるので __dirname は
//     プロジェクトルートだが、`path.join(__dirname, '../../proto/lightning.proto')` と
//     書かれており、ルートの 2 つ上（/home/proto/...）＝プロジェクトの外を指していた。
//     そもそも proto ファイルはリポジトリに含まれていない。
//  2. 接続に失敗すると**黙ってモックへ落ちていた**。モックの addInvoice は
//     `'lnbc' + 金額 + '1' + ランダムな base64` を返す。BOLT11 に見えるが、
//     どのウォレットでも支払えないただの文字列である。
//
// その結果、実 LND が無い環境では:
//   - /ready は lightning: "available" と報告する
//   - POST /payments/order/:id は 201 で「ウォレットで支払ってください」と返す
//   - 借り手は支払えない請求書を渡され、運営は Lightning が動いていると思い込む
//
// 決済系で確信を持って嘘をつくのは、明示的に失敗するより悪い。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const OrderRepository = require('../../src/db/json/OrderRepository');

const uniq = Date.now().toString(36);
let tok, userId;

beforeAll(async () => {
  const name = `lnhon${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: name, email, password: 'Test1234!' });
  userId = UserRepository.getByEmail(email).id;
  tok = (await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' })).body.token;
});

function seedPayableOrder() {
  const gpu = GpuRepository.create({
    name: `LN Honesty GPU ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090',
    memoryGB: 24, pricePerHour: 60000, providerId: `prov-${uniq}`,
  });
  return OrderRepository.create({
    gpuId: gpu.id, userId, providerId: `prov-${uniq}`,
    durationMinutes: 60, status: 'matched',
    pricePerHour: 60000, totalPrice: 60000, totalPriceJPY: 6000,
  });
}

describe('a Lightning invoice from a mock node', () => {
  it('is reported as not payable, and the message says so', async () => {
    const order = seedPayableOrder();
    const res = await request(app).post(`/api/v1/payments/order/${order.id}`)
      .set('Authorization', `Bearer ${tok}`).send({});

    // 実 LND が無い環境ではモックが使われる（テストでは許可されている）。
    // 請求書自体は返ってよいが、「支払える」と主張してはいけない。
    if (res.status === 503) return; // Lightning サービス自体が無効な構成
    expect(res.status).toBe(201);
    expect(res.body.payable).toBe(false);
    expect(res.body.message).toMatch(/CANNOT be paid/i);
    // 「ウォレットで支払ってください」と案内してはいけない
    expect(res.body.message).not.toMatch(/Pay using your Lightning wallet/i);
  });

  it('still records the payment as pending rather than inventing a settlement', async () => {
    // 支払えない請求書を「支払い済み」に見せるのは論外。
    const order = seedPayableOrder();
    const res = await request(app).post(`/api/v1/payments/order/${order.id}`)
      .set('Authorization', `Bearer ${tok}`).send({});
    if (res.status === 503) return;
    expect(res.body.status).toBe('pending');
  });
});

describe('the mock is opt-in, never a silent production fallback', () => {
  const { LightningService } = require('../../lightning-service');

  it('refuses to fall back to the mock unless explicitly allowed', async () => {
    // 本番（NODE_ENV!=test かつ LIGHTNING_MOCK!=1）で LND に繋がらなければ、
    // モックへ落ちずに失敗すること。支払えない請求書を配るくらいなら 503 が正しい。
    const savedEnv = process.env.NODE_ENV;
    const savedMock = process.env.LIGHTNING_MOCK;
    process.env.NODE_ENV = 'production';
    delete process.env.LIGHTNING_MOCK;
    try {
      const svc = new LightningService({ host: '127.0.0.1:1', certPath: '/nonexistent', macaroonPath: '/nonexistent' });
      await expect(svc.connectToLND(0, false)).rejects.toThrow(/mock mode is not enabled/i);
      expect(svc.lnd).toBeNull();
      expect(svc.mockMode).toBe(false);
    } finally {
      process.env.NODE_ENV = savedEnv;
      if (savedMock !== undefined) process.env.LIGHTNING_MOCK = savedMock;
    }
  }, 20000);

  it('uses the mock when explicitly enabled, and marks itself as mock', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.LIGHTNING_MOCK = '1';
    try {
      const svc = new LightningService({ host: '127.0.0.1:1', certPath: '/nonexistent', macaroonPath: '/nonexistent' });
      await svc.connectToLND(0, false);
      expect(svc.mockMode).toBe(true);
      const inv = await svc.createInvoice({ value: 1000, memo: 'x' });
      expect(inv.payable).toBe(false);
      expect(inv.mock).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
      delete process.env.LIGHTNING_MOCK;
    }
  }, 20000);
});

describe('the proto path', () => {
  it('resolves inside the project, not two levels above it', () => {
    // 壊れていたときの実際の値は /home/proto/lightning.proto（プロジェクト外）。
    const src = require('fs').readFileSync(require.resolve('../../lightning-service.js'), 'utf-8');
    expect(src).not.toMatch(/\.\.\/\.\.\/proto\/lightning\.proto/);
    expect(src).toMatch(/LND_PROTO_PATH/);
  });
});
