// tests/security/google-oauth-session.test.js
// POST /auth/google がパスワードログインと同等のトークンペアを返すことを検証。
// 従来は access token のみを返しており、OAuth ユーザーは 1h ごとの強制再ログイン
// になり、ログアウト時の refresh 失効経路にも乗らなかった。
// google-auth-library はインストール済みだが実 OAuth は呼べないためモックで
// verifyIdToken のみ差し替える。
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn(async ({ idToken }) => {
      if (idToken !== 'valid-token') throw new Error('invalid token');
      return {
        getPayload: () => ({
          sub: 'g-sub-test-1',
          email: 'oauthuser@example.com',
          email_verified: true,
          name: 'OAuth User',
          picture: 'https://example.com/p.png',
        }),
      };
    }),
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const { isRevoked } = require('../../src/api/middleware/token-denylist');

describe('POST /auth/google: session issuance', () => {
  it('returns an access + refresh token pair and updates lastLogin', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'valid-token' });
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();

    const access = jwt.decode(res.body.token);
    const refresh = jwt.decode(res.body.refreshToken);
    expect(access.type).toBe('access');
    expect(access.jti).toBeTruthy();
    expect(refresh.type).toBe('refresh');
    // ati で refresh が access の jti に紐付く（rotation 時に旧 access を失効させるため）
    expect(refresh.ati).toBe(access.jti);

    const user = UserRepository.getByEmail('oauthuser@example.com');
    expect(user).toBeTruthy();
    expect(user.lastLogin).toBeTruthy();
  });

  it('the returned refresh token rotates via /users/refresh and revokes the paired access token', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'valid-token' });
    expect(res.statusCode).toBe(200);

    const r = await request(app).post('/api/v1/users/refresh')
      .send({ refreshToken: res.body.refreshToken });
    expect(r.statusCode).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.refreshToken).toBeTruthy();

    // rotation により旧 access token（ati 経由）と消費済み refresh jti が失効
    const oldAccess = jwt.decode(res.body.token);
    const oldRefresh = jwt.decode(res.body.refreshToken);
    expect(isRevoked(oldAccess.jti)).toBe(true);
    expect(isRevoked(oldRefresh.jti)).toBe(true);
  });

  it('rejects an invalid Google id token with 401 and issues nothing', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'bogus' });
    expect(res.statusCode).toBe(401);
    expect(res.body.token).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });
});

afterAll((done) => {
  const { server } = require('../../src/api/server');
  if (server && server.close) server.close(() => done());
  else done();
});
