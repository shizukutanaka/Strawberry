// tests/api/gpu-recommended-sort.test.js
// GET /gpus?sort=recommended — 価格・レピュテーション・稼働・アテステーションを
// 1 本の効用スコアにまとめた総合順位。
//
// 経緯: この計算はもともと逆オークション（POST /marketplace/auction）用に書かれたが、
// この製品には入札という概念そのものが無い（GPU は固定価格で出品され、入札を保存する
// 場所も、貸し手が借り手の要件を見る画面も無い）。旧エンドポイントは入札の配列を
// **リクエストボディから**受け取っており、価格を含めて呼び出し側が捏造できたので、
// 返る「落札者」は何も意味しなかった。エンドポイントは削除し、計算だけを
// 「サーバが持っている実データで実在の出品を並べる」用途に移した。
//
// ここで守りたい性質は「安いが低評価」より「少し高いが高評価」を上に出すこと。
// 単軸ソート（価格順・評価順…）の寄せ集めでは、借り手はこの比較ができない。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const { createReputationService } = require('../../src/reputation/reputation-service');

const uniq = Date.now().toString(36);
const TAG = `Recommended ${uniq}`;
let tok, strongId, weakId;

beforeAll(async () => {
  const name = `recsort${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: name, email, password: 'Test1234!' });
  tok = (await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' })).body.token;

  const mkProvider = async (prefix) => {
    const n = `${prefix}${uniq}`.slice(0, 20);
    await request(app).post('/api/v1/users/register')
      .send({ username: n, email: `${n}@example.com`, password: 'Test1234!', role: 'provider' });
    return UserRepository.getByEmail(`${n}@example.com`).id;
  };
  strongId = await mkProvider('recstrong');
  weakId = await mkProvider('recweak');

  const rep = createReputationService();
  for (let i = 0; i < 100; i++) rep.recordJobResult(strongId, true);
  rep.addStake(strongId, 5_000_000);
  rep.recordJobResult(weakId, false);

  // 低評価プロバイダの方が**安い**。それでも上に来てはいけない。
  GpuRepository.create({
    name: `${TAG} strong`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24,
    pricePerHour: 160, providerId: strongId, available: true, apiType: 'CUDA',
  });
  GpuRepository.create({
    name: `${TAG} weak`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24,
    pricePerHour: 150, providerId: weakId, available: true, apiType: 'CUDA',
  });
});

const listRecommended = () => request(app)
  .get(`/api/v1/gpus?sort=recommended&search=${encodeURIComponent(TAG)}&limit=200`)
  .set('Authorization', `Bearer ${tok}`);

describe('GET /gpus?sort=recommended', () => {
  it('ranks a well-reputed provider above a slightly cheaper poorly-reputed one', async () => {
    const res = await listRecommended();
    expect(res.status).toBe(200);
    const names = res.body.gpus.map((g) => g.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(`${TAG} strong`);
  });

  it('returns the score so the ordering can be explained, not just asserted', async () => {
    // 順位だけ返して根拠を返さないと、利用者は「なぜこの順番か」を確かめられない。
    const res = await listRecommended();
    const [first, second] = res.body.gpus;
    expect(typeof first.recommendScore).toBe('number');
    expect(first.recommendScore).toBeGreaterThan(second.recommendScore);
    expect(first.recommendScore).toBeGreaterThan(0);
    expect(first.recommendScore).toBeLessThanOrEqual(1);
  });

  it('does not attach a score to other sort modes', async () => {
    // 常時付けると「この並びは総合スコア順だ」と誤読させる。
    const res = await request(app)
      .get(`/api/v1/gpus?sort=price&search=${encodeURIComponent(TAG)}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.body.gpus[0].recommendScore).toBeUndefined();
  });

  it('still sorts by price when asked, so the cheap one wins there', async () => {
    const res = await request(app)
      .get(`/api/v1/gpus?sort=price&search=${encodeURIComponent(TAG)}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.body.gpus[0].name).toBe(`${TAG} weak`);
  });

  it('is available without inventing any input — the caller supplies no bids', async () => {
    // 旧 POST /marketplace/auction は入札を body から取っていた。削除済みであること。
    const gone = await request(app).post('/api/v1/marketplace/auction')
      .set('Authorization', `Bearer ${tok}`).send({ bids: [] });
    expect(gone.status).toBe(404);
  });

  it('does not fall over when a listing has no reputation history at all', async () => {
    const orphan = `${TAG} orphan`;
    GpuRepository.create({
      name: orphan, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24,
      pricePerHour: 155, providerId: `never-seen-${uniq}`, available: true, apiType: 'CUDA',
    });
    const res = await listRecommended();
    expect(res.status).toBe(200);
    expect(res.body.gpus.map((g) => g.name)).toContain(orphan);
    for (const g of res.body.gpus) expect(typeof g.recommendScore).toBe('number');
  });
});
