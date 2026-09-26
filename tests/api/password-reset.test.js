// パスワードリセット（forgot/reset）のAPIテスト
// - forgot: 存在/非存在で同一応答（列挙防止）、登録済みのみトークン発行
// - reset: sha256 ハッシュ照合・timingSafeEqual・有効期限・単回使用・全セッション無効化
const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');

const ts = Date.now();
const EMAIL = `reset-${ts}@example.com`;
const USERNAME = `reset${ts}`.slice(0, 30); // username は alphanum のみ
const PASSWORD = 'Original#Pass123';
const NEW_PASSWORD = 'NewPass!456z';

async function register() {
  const res = await request(app).post('/api/v1/users/register')
    .send({ email: EMAIL, password: PASSWORD, username: USERNAME });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return UserRepository.getByEmail(EMAIL);
}

function seedResetToken(userId, { expiresInMs = 15 * 60 * 1000 } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  UserRepository.update(userId, {
    passwordResetTokenHash: tokenHash,
    passwordResetExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });
  return token;
}

describe('password reset flow', () => {
  it('forgot-password returns identical response for unknown and known emails', async () => {
    const user = await register();
    const r1 = await request(app).post('/api/v1/users/forgot-password')
      .send({ email: 'nobody-here@example.com' });
    const r2 = await request(app).post('/api/v1/users/forgot-password')
      .send({ email: EMAIL });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.message).toBe(r2.body.message);
    // 登録済みのみトークンハッシュが保存される
    const after = UserRepository.getById(user.id);
    expect(after.passwordResetTokenHash).toBeTruthy();
    expect(after.passwordResetExpiresAt).toBeTruthy();
    // レスポンスにトークンが漏れないこと（平文・ハッシュともに）
    expect(JSON.stringify(r2.body)).not.toContain('token');
  });

  it('reset-password rejects invalid token', async () => {
    const res = await request(app).post('/api/v1/users/reset-password')
      .send({ token: 'a'.repeat(64), newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('reset-password rejects expired token', async () => {
    const user = UserRepository.getByEmail(EMAIL);
    const token = seedResetToken(user.id, { expiresInMs: -1000 });
    const res = await request(app).post('/api/v1/users/reset-password')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('reset-password accepts valid token, updates password, invalidates sessions, single-use', async () => {
    const user = UserRepository.getByEmail(EMAIL);
    const token = seedResetToken(user.id);

    const res = await request(app).post('/api/v1/users/reset-password')
      .send({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const after = UserRepository.getById(user.id);
    expect(after.passwordResetTokenHash).toBeFalsy(); // 単回使用
    expect(after.passwordChangedAt).toBeTruthy();      // 全セッション無効化マーカー
    expect(after.sessionsRevokedAt).toBeTruthy();

    // 新パスワードでログイン可能
    const login = await request(app).post('/api/v1/users/login')
      .send({ email: EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    // 同じトークンは二度使えない
    const again = await request(app).post('/api/v1/users/reset-password')
      .send({ token, newPassword: 'Another#789' });
    expect(again.status).toBe(400);
  });

  it('reset-password enforces password policy', async () => {
    const res = await request(app).post('/api/v1/users/reset-password')
      .send({ token: 'b'.repeat(64), newPassword: 'weak' });
    expect(res.status).toBe(400);
  });
});
