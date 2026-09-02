// tests/api/notification-settings-roundtrip.test.js
// 通知先の GET → 編集 → POST が往復できること。
//
// GET は lineToken を '***' に伏せて返し、POST は設定全体を置き換える。この 2 つを
// 素直に組み合わせると、画面が読んだ '***' をそのまま送り返した瞬間に
// (a) Joi のパターン検証で 400 になる、または (b) 伏せ字を保存して本物のトークンが消える。
// どちらも「設定画面を作った途端に壊れる」性質で、画面が無かったから見つからなかった。
// '***' は「変更なし」として既存値を保つ。
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `nsrt${Date.now().toString(36)}`;
const LINE_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise((done) => (server && server.close ? server.close(() => done()) : done()));
});

async function makeUser() {
  const name = `${uniq}u`.slice(0, 20);
  const email = `${name}@example.com`;
  await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
  const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  return { id: UserRepository.getByEmail(email).id, token };
}

describe('notification settings survive a read-modify-write cycle from the UI', () => {
  let user;
  beforeAll(async () => { user = await makeUser(); });

  it('stores a real LINE token and masks it on read', async () => {
    const save = await request(app).post(`/api/v1/notification-settings/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ lineToken: LINE_TOKEN, email: 'a@example.com' });
    expect(save.statusCode).toBe(200);
    const read = await request(app).get(`/api/v1/notification-settings/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(read.body.lineToken).toBe('***');
    expect(read.body.email).toBe('a@example.com');
  });

  it('posting the masked value back keeps the stored token instead of rejecting or overwriting it', async () => {
    const save = await request(app).post(`/api/v1/notification-settings/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ lineToken: '***', email: 'b@example.com' });
    expect(save.statusCode).toBe(200);
    // 保存された実体を直接確認（API は伏せるので）
    const fs = require('fs');
    const path = require('path');
    const stored = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/notification-settings.json'), 'utf-8'))[user.id];
    expect(stored.lineToken).toBe(LINE_TOKEN);
    expect(stored.email).toBe('b@example.com');
  });

  it('an explicit empty string still clears the token', async () => {
    await request(app).post(`/api/v1/notification-settings/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ lineToken: '', email: 'c@example.com' });
    const read = await request(app).get(`/api/v1/notification-settings/${user.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(read.body.lineToken).toBeFalsy();
  });

  it("'***' with nothing stored is simply dropped (no phantom token)", async () => {
    const other = await (async () => {
      const name = `${uniq}v`.slice(0, 20);
      const email = `${name}@example.com`;
      await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
      const token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
      return { id: UserRepository.getByEmail(email).id, token };
    })();
    const save = await request(app).post(`/api/v1/notification-settings/${other.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ lineToken: '***', email: 'd@example.com' });
    expect(save.statusCode).toBe(200);
    const read = await request(app).get(`/api/v1/notification-settings/${other.id}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(read.body.lineToken).toBeUndefined();
  });
});
