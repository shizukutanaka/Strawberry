// tests/api/gpu-minimal-listing.test.js
// 「貸し手が手元で答えられる 5 項目だけで出品できる」ことの回帰テスト。
// 以前は apiType / driverVersion / os / arch / clockMHz / powerWatt も必須で、
// 実サーバに対して最小構成で POST すると 400 になった。二面市場では供給側の
// 登録が最初の行為なので、ここが通らないと市場そのものが立ち上がらない。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = Date.now().toString(36);
let provTok;

beforeAll(async () => {
  const name = `minlist${uniq}`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register')
    .send({ username: name, email, password: 'Test1234!', role: 'provider' });
  const user = UserRepository.getByEmail(email);
  if (user.role !== 'provider') UserRepository.update(user.id, { role: 'provider' });
  provTok = (await request(app).post('/api/v1/users/login')
    .send({ email, password: 'Test1234!' })).body.token;
});

const post = (body) => request(app).post('/api/v1/gpus')
  .set('Authorization', `Bearer ${provTok}`).send(body);

describe('POST /gpus with only the five fields a provider actually knows', () => {
  let created;

  it('accepts name / vendor / model / memoryGB / pricePerHour alone', async () => {
    const res = await post({
      name: `Minimal 4090 ${uniq}`, vendor: 'NVIDIA', model: 'GeForce RTX 4090',
      memoryGB: 24, pricePerHour: 120000,
    });
    expect(res.status).toBe(201);
    created = res.body.gpu;
  });

  it('derives apiType, arch and powerWatt from the model', () => {
    expect(created.apiType).toBe('CUDA');
    expect(created.arch).toBe('x86_64');
    expect(created.powerWatt).toBe(450); // RTX 4090 の公称 TDP
  });

  it('records which fields were derived so the UI can label them', () => {
    // 推定値を申告値として表示すると「未確認のものを確認済みに見せる」ことになる。
    expect(created.derivedFields.sort()).toEqual(['apiType', 'arch', 'powerWatt']);
  });

  it('leaves the display-only fields unset rather than inventing them', () => {
    expect(created.driverVersion).toBeUndefined();
    expect(created.os).toBeUndefined();
    expect(created.clockMHz).toBeUndefined();
  });

  it('still sets capabilities from the derived apiType', () => {
    expect(created.capabilities.cuda).toBe(true);
  });

  it('does not override anything the provider did declare', async () => {
    const res = await post({
      name: `Declared 4090 ${uniq}`, vendor: 'NVIDIA', model: 'GeForce RTX 4090',
      memoryGB: 24, pricePerHour: 120000,
      apiType: 'OpenCL', arch: 'arm64', powerWatt: 275, os: 'Ubuntu 24.04',
    });
    expect(res.status).toBe(201);
    expect(res.body.gpu).toMatchObject({ apiType: 'OpenCL', arch: 'arm64', powerWatt: 275, os: 'Ubuntu 24.04' });
    expect(res.body.gpu.derivedFields).toBeUndefined();
  });

  it('leaves powerWatt unset for a model that is not in the reference table', async () => {
    const res = await post({
      name: `Unknown GPU ${uniq}`, vendor: 'NVIDIA', model: 'Acme Ultra 9000',
      memoryGB: 16, pricePerHour: 50000,
    });
    expect(res.status).toBe(201);
    expect(res.body.gpu.powerWatt).toBeUndefined();
    expect(res.body.gpu.derivedFields).not.toContain('powerWatt');
  });

  it('still rejects a listing missing something only the provider can supply', async () => {
    // 緩めたのは導出できる項目だけ。値段や VRAM は誰も代われない。
    const noPrice = await post({ name: `NoPrice ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24 });
    expect(noPrice.status).toBe(400);
    const noMemory = await post({ name: `NoMem ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090', pricePerHour: 1000 });
    expect(noMemory.status).toBe(400);
    const noModel = await post({ name: `NoModel ${uniq}`, vendor: 'NVIDIA', memoryGB: 24, pricePerHour: 1000 });
    expect(noModel.status).toBe(400);
  });

  it('still rejects an out-of-range declared powerWatt', async () => {
    const res = await post({
      name: `BadWatt ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090',
      memoryGB: 24, pricePerHour: 1000, powerWatt: 999999,
    });
    expect(res.status).toBe(400);
  });

  it('makes the minimal listing visible to renters with a performance score', async () => {
    const res = await request(app).get(`/api/v1/gpus/${created.id}`)
      .set('Authorization', `Bearer ${provTok}`);
    expect(res.status).toBe(200);
    const gpu = res.body.gpu || res.body;
    expect(gpu.performanceScore || (gpu.performance && gpu.performance.score)).toBeDefined();
  });
});
