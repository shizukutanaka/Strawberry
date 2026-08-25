// tests/api/route-reachability.test.js
// 登録されている**全ルート**を機械的に洗い、恒久的に壊れている経路が無いことを確かめる。
//
// きっかけ: このセッションの不具合はどれも「実際に動かしていて気づいた」ものだった。
// 個別の経路を人間が思い出して確認する方式は、経路が増えるたびに漏れる。
// ルート表そのものを入力にして全数当たれば、確認漏れという概念が無くなる。
//
// 実際この方式で `GET /gpus/system/detected` の 500 が見つかった
// （gpuDetector.detectAllGPUs というメソッドが存在しないのに呼んでいた。
// service-monitor が sendSlackMessage を存在しない名前で呼んでいたのと同じ形）。
//
// 判定基準は「5xx を返す経路がゼロであること」。4xx は検証・認可が効いている
// 証拠なので正常（実在しない ID を渡すので 404 は当然出る）。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const UUID = '00000000-0000-4000-8000-000000000001';
/** Express のルータスタックから登録済みルートを取り出す。 */
function collectRoutes() {
  const routes = [];
  function walk(stack, prefix) {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) {
          routes.push({ method: m.toUpperCase(), path: prefix + l.route.path });
        }
      } else if (l.name === 'router' && l.handle && l.handle.stack) {
        let seg = '';
        if (l.regexp && l.regexp.source !== '^\\/?(?=\\/|$)') {
          seg = l.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '')
            .replace(/\\\//g, '/').replace(/\$$/, '');
        }
        walk(l.handle.stack, prefix + seg);
      }
    }
  }
  walk(app._router.stack, '');
  const seen = new Set();
  return routes.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k) || r.path.includes('*')) return false;
    // OAuth は外部 IdP へのリダイレクトなので到達性の意味が違う
    if (/auth\/(google|github)|master-auth/.test(r.path)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 認証済みのユーザー/管理者トークンを**使う直前に**作る。
 *
 * beforeAll で作って後から使う形にしていたら 401 になった。jest は 148 スイートを
 * 並列で走らせ、全スイートが同じ data/users.json を共有する。別スイートの書き込みで
 * こちらのユーザーが消え、jwt-auth のユーザー実在チェックに落ちる。
 *
 * さらに悪いことに、**401 は 5xx ではない**ので、この掃き出しは「全ルート正常」と
 * 報告してしまう。認証が死んだまま緑になる検査には何の意味も無いため、
 * カナリアで実際に認証が通っていることを確かめてから本題に入る。
 */
async function freshTokens() {
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const mk = async (prefix) => {
    const name = `${prefix}${uniq}`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register')
      .send({ username: name, email, password: 'Test1234!' });
    return email;
  };
  const userEmail = await mk('rru');
  const adminEmail = await mk('rra');
  const adminRow = UserRepository.getByEmail(adminEmail);
  expect(adminRow).toBeTruthy();
  UserRepository.update(adminRow.id, { role: 'admin' });
  const login = async (email) => (await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' })).body.token;
  const userTok = await login(userEmail);
  const adminTok = await login(adminEmail);

  // カナリア: 認証が本当に通っているか。ここが 200 でなければ以降の結果は無意味。
  const canary = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${adminTok}`);
  expect(canary.status).toBe(200);
  return { userTok, adminTok };
}

describe('every registered route', () => {
  it('is discoverable from the Express router (sanity check on the probe itself)', () => {
    // 収集が壊れて 0 件になると「全部 green」に見えてしまうので下限を置く。
    expect(collectRoutes().length).toBeGreaterThan(100);
  });

  it('never returns 5xx for an authenticated request', async () => {
    let tokens = await freshTokens();
    const failures = [];
    let authenticated = 0;
    let unauthenticated = 0;

    // 走査の途中でトークンが無効になることがある。jest は 148 スイートを並列で
    // 走らせ、全スイートが同じ data/users.json を共有するので、別スイートの
    // 書き込みでこちらのユーザーが消えると jwt-auth のユーザー実在チェックに落ちる。
    // 401 を「そういうもの」として数えると検査が空洞化するので、**取り直して再試行**する。
    const call = async (r, url, tok) => {
      const req = request(app)[r.method.toLowerCase()](url).set('Authorization', `Bearer ${tok}`);
      return ['POST', 'PUT', 'PATCH'].includes(r.method) ? req.send({}) : req;
    };

    for (const r of collectRoutes()) {
      const url = r.path.replace(/:([A-Za-z]+)/g,
        (_m, name) => (/id|Id|root|jobId|blockId/.test(name) ? UUID : 'x'));
      for (const [who, key] of [['admin', 'adminTok'], ['user', 'userTok']]) {
        let res;
        try {
          res = await call(r, url, tokens[key]);
          if (res.status === 401) {
            tokens = await freshTokens();          // 並列スイートに消された可能性
            res = await call(r, url, tokens[key]); // 一度だけ取り直して再試行
          }
        } catch (e) {
          failures.push(`${r.method} ${r.path} [${who}] THREW ${e.message}`);
          continue;
        }
        if (res.status >= 500) {
          failures.push(`${r.method} ${r.path} [${who}] -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
        }
        if (res.status === 401) unauthenticated += 1; else authenticated += 1;
        if (res.status < 500) break; // 5xx でなければ他ロールを試す必要は無い
      }
    }

    // 認証が死んだまま全部 401 になれば「5xx ゼロ」で緑になってしまう。
    // 検査が実体を伴っていたことを、通過した本数で担保する。
    expect(authenticated).toBeGreaterThan(collectRoutes().length * 0.9);
    expect(unauthenticated).toBeLessThan(collectRoutes().length * 0.1);
    expect(failures).toEqual([]);
  }, 180000);
});

describe('GET /gpus/system/detected', () => {
  it('responds instead of crashing on a missing detector method', async () => {
    // 全数調査で見つかった唯一の 5xx。detectAllGPUs が存在しないまま呼ばれていた。
    const { adminTok } = await freshTokens();
    const res = await request(app).get('/api/v1/gpus/system/detected')
      .set('Authorization', `Bearer ${adminTok}`);
    // 検出器が読み込めない環境では 503（設計どおり）、読めれば 200。500 は不可。
    expect([200, 503]).toContain(res.status);
  });

  it('says which vendors it does not look for, rather than implying none were found', async () => {
    // AMD/Intel しか実装が無い。空配列だけ返すと NVIDIA 機の運用者が
    // 「このホストに GPU は無い」と誤解する。
    const { adminTok } = await freshTokens();
    const res = await request(app).get('/api/v1/gpus/system/detected')
      .set('Authorization', `Bearer ${adminTok}`);
    expect(res.status).not.toBe(401); // 認証が死んだまま素通りさせない
    if (res.status !== 200) return; // 検出器未導入の環境ではスキップ
    expect(res.body.vendorsNotDetected).toContain('NVIDIA');
    expect(res.body.vendorsCovered).toEqual(expect.arrayContaining(['AMD', 'Intel']));
    expect(Array.isArray(res.body.gpus)).toBe(true);
  });
});

describe('escrow endpoints map failures to the right status', () => {
  // 全ルート走査で見つかった 2 件目の欠陥。存在しない ID を渡しただけで 500 を
  // 返しており、クライアントは自分の誤りとサーバ障害を区別できず、監視側は
  // 通常の 404 相当をエラー率に数えていた。実 ID しか使わない通し確認では
  // 決して踏まない類の穴で、全数調査だから見つかった。
  it('returns 404, not 500, for an escrow that does not exist', async () => {
    const { adminTok } = await freshTokens();
    for (const path of [
      `/api/v1/marketplace/escrow/${UUID}/pay`,
    ]) {
      const res = await request(app).post(path).set('Authorization', `Bearer ${adminTok}`).send({});
      expect(res.status).toBe(404);
      expect(String(res.body.error)).toMatch(/not found/i);
    }
  });

  it('still returns 404 (not 500) when reading a missing escrow', async () => {
    const { adminTok } = await freshTokens();
    const res = await request(app).get(`/api/v1/marketplace/escrow/${UUID}`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(res.status).toBe(404);
  });
});
