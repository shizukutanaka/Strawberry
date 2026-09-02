// tests/api/no-dead-endpoints.test.js
// 登録済みの全ルートを機械的に列挙して実際に叩き、**決して成功しないエンドポイントが
// 存在しない**ことを保証する。
//
// なぜこれが要るか: このリポジトリには「登録されているが原理的に動かない」API が
// 繰り返し現れた。
//   - POST /orders/:id/match     … P2P レイヤが読み込みにすら失敗し常に 503
//   - POST /marketplace/auction  … 入札という概念自体が存在しない
//   - POST /gpus/:id/benchmark   … サーバは他人のマシンでコードを実行できないため
//                                   `not implemented` を 500 で返し続けていた
// いずれも「実装済み」として仕様書に載っていた。個別に気づいて潰すやり方では、
// 次に同じものが増えたときにまた見逃す。ルート表から機械的に確かめる。
//
// 判定基準:
//   NG … 5xx（サーバ側の破綻）と 503（存在するが決して利用できない）
//   OK … 400/401/403/404/409 等。認証・入力検証・存在確認で弾くのは正しい動作
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = Date.now().toString(36).slice(-6);
let adminTok, gpuId, orderId;

/** Express のルータスタックを歩いて登録済みルートを集める。 */
function collectRoutes(stack, prefix = '', out = []) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => m !== '_all').map((m) => m.toUpperCase());
      for (const m of methods) out.push({ method: m, path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      let p = '';
      if (layer.regexp && layer.regexp.source !== '^\\/?(?=\\/|$)') {
        p = layer.regexp.source
          .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/')
          .replace('(?=\\/|$)', '').replace(/\$$/, '').replace(/\?$/, '');
      }
      collectRoutes(layer.handle.stack, prefix + p, out);
    }
  }
  return out;
}

// 外部 OAuth へリダイレクトするもの、catch-all、状態を壊す操作は対象外。
// （監査が目的であって、データを壊すのが目的ではない）
const SKIP = /^\*$|master-auth|\/auth\/(google|github)/;
const DESTRUCTIVE = /\/(stop|preempt|dispute|resolve|purge|expire-orders|unlink|logout|refresh)/;

beforeAll(async () => {
  const mk = async (prefix, role) => {
    const username = `${prefix}${uniq}`.slice(0, 20);
    const email = `${username}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username, email, password: 'Test1234!', ...(role ? { role } : {}) });
    return { email, id: UserRepository.getByEmail(email).id };
  };
  const prov = await mk('deadprov', 'provider');
  const rent = await mk('deadrent');
  const adm = await mk('deadadm');
  UserRepository.update(adm.id, { role: 'admin' });
  const login = async (email) => (await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' })).body.token;
  adminTok = await login(adm.email);
  const provTok = await login(prov.email);
  const rentTok = await login(rent.email);

  // :id を実在のリソースで埋める（存在しない ID だと 404 ばかりになり、
  // ハンドラ本体まで到達せず「動くこと」の検査にならない）
  const gpuRes = await request(app).post('/api/v1/gpus')
    .set('Authorization', `Bearer ${provTok}`)
    .send({ name: `Dead Probe GPU ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 1000 });
  gpuId = gpuRes.body.gpu && gpuRes.body.gpu.id;
  const orderRes = await request(app).post('/api/v1/orders')
    .set('Authorization', `Bearer ${rentTok}`)
    .send({ gpuId, durationMinutes: 60 });
  orderId = orderRes.body.orderId;
}, 30000);

describe('every registered endpoint can actually respond', () => {
  it('has routes to check at all (guards against the walker silently finding none)', () => {
    const routes = collectRoutes(app._router.stack);
    expect(routes.length).toBeGreaterThan(50);
  });

  it('returns no 5xx and no 503 from any registered route', async () => {
    const UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const routes = collectRoutes(app._router.stack)
      .filter((r) => !SKIP.test(r.path));

    const failures = [];
    for (const { method, path: raw } of routes) {
      const path = raw
        .replace(':root', 'a'.repeat(64))
        .replace(':userId', 'me')
        .replace(/:id/, raw.includes('/orders/') ? orderId : raw.includes('/gpus/') ? gpuId : UUID)
        .replace(/:\w+/g, UUID)
        .replace(/\/$/, '') || '/';
      if (DESTRUCTIVE.test(path)) continue;

      const call = request(app)[method.toLowerCase()](path).set('Authorization', `Bearer ${adminTok}`);
      const res = await (method === 'GET' ? call : call.send({}));
      if (res.status >= 500 || res.status === 503) {
        failures.push(`${method} ${raw} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120000);
});
