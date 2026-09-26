// tests/security/oauth-web-flow.test.js
// Web OAuth フロー（GET /auth/google|github/callback）の回帰テスト。
// 従来はコールバックが OAuth プロフィールを echo するだけで Strawberry の
// トークンを一切発行せず（実質未完結）、かつ state パラメータが無く
// login-CSRF が成立していた。
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { _completeOAuthLogin } = require('../../src/api/routes/auth');
const UserRepository = require('../../src/db/json/UserRepository');

const uniq = `oath${Date.now().toString(36)}`;

describe('completeOAuthLogin', () => {
  const profile = (over = {}) => ({
    id: `gh-${uniq}`,
    displayName: 'OAuth Web User',
    emails: [{ value: `${uniq}@example.com`, verified: true }],
    ...over,
  });

  it('issues an access+refresh token pair for a new GitHub user', () => {
    const res = _completeOAuthLogin('github', profile());
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    const access = jwt.decode(res.body.token);
    const refresh = jwt.decode(res.body.refreshToken);
    expect(access.type).toBe('access');
    expect(refresh.type).toBe('refresh');
    expect(refresh.ati).toBe(access.jti);
    const user = UserRepository.getByGithubId(`gh-${uniq}`);
    expect(user).toBeTruthy();
    expect(user.lastLogin).toBeTruthy();
  });

  it('rejects unverified provider email', () => {
    const res = _completeOAuthLogin('github',
      profile({ id: `gh2-${uniq}`, emails: [{ value: `nv${uniq}@example.com`, verified: false }] }));
    expect(res.status).toBe(401);
  });

  it('rejects profiles without email', () => {
    const res = _completeOAuthLogin('google', { id: `g-${uniq}`, displayName: 'No Email' });
    expect(res.status).toBe(400);
  });

  it('does not implicitly link to an existing password account with the same email', () => {
    // 既存のパスワードアカウントと同じメールの OAuth ログインは暗黙リンクせず 409
    const email = `conflict${uniq}@example.com`;
    UserRepository.create({ username: `conflict${uniq}`.slice(0, 30), email, password: 'hashed', role: 'user' });
    const res = _completeOAuthLogin('github',
      profile({ id: `gh3-${uniq}`, emails: [{ value: email, verified: true }] }));
    expect(res.status).toBe(409);
    // githubId はリンクされない
    expect(UserRepository.getByGithubId(`gh3-${uniq}`)).toBeFalsy();
  });
});

describe('web-flow hardening (source guards)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/auth.js'), 'utf-8');

  it('passes state:true to passport.authenticate (login-CSRF protection)', () => {
    // 開始・コールバック両方の authenticate 呼出しに state:true が必要
    const calls = src.match(/passport\.authenticate\('(?:google|github)'[^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c).toMatch(/state:\s*true/);
  });

  it('mounts a session middleware so passport-oauth2 state store works', () => {
    expect(src).toMatch(/masterSession/);
  });
});
