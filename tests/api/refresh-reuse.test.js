// Refresh-token reuse detection (OWASP token-family revocation).
// Single-use rotation alone only 401s the replayed token — an attacker who
// rotated *forward* keeps a live refresh token. On detecting reuse of an
// already-consumed refresh token we must revoke the whole family: the
// rotated-forward refresh token AND outstanding access tokens become invalid,
// forcing a full re-login.
const request = require('supertest');
const { app } = require('../../src/api/server');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshLogin(prefix) {
  const u = `${prefix}${Date.now().toString(36)}`.slice(0, 22);
  const email = `${u}@example.com`;
  const password = 'Test1234!';
  await request(app).post('/api/v1/users/register').send({ username: u, email, password });
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  return { ...login.body, email, password };
}

describe('refresh-token reuse detection revokes the whole family', () => {
  it('revokes the rotated-forward refresh token and access tokens when an old refresh token is replayed', async () => {
    const { token: A0, refreshToken: R0, email, password } = await freshLogin('reuse');

    // Rotate once: R0 -> R1 (+ A1). This is the legitimate first use.
    const rot = await request(app).post('/api/v1/users/refresh').send({ refreshToken: R0 });
    expect(rot.statusCode).toBe(200);
    const R1 = rot.body.refreshToken;
    const A1 = rot.body.token;

    // A1 works before any reuse is detected.
    expect((await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${A1}`)).statusCode).toBe(200);

    // Attacker replays the now-consumed R0 -> reuse detected.
    const replay = await request(app).post('/api/v1/users/refresh').send({ refreshToken: R0 });
    expect(replay.statusCode).toBe(401);
    expect(replay.body.error).toMatch(/reuse detected/i);

    // The rotated-forward refresh token R1 (held by attacker or victim) is now dead.
    const r1use = await request(app).post('/api/v1/users/refresh').send({ refreshToken: R1 });
    expect(r1use.statusCode).toBe(401);

    // Access tokens issued before the revocation are rejected too.
    expect((await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${A1}`)).statusCode).toBe(401);
    expect((await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${A0}`)).statusCode).toBe(401);

    // Recovery: a fresh login (issued strictly after the revocation second) works again.
    await delay(1100);
    const relogin = await request(app).post('/api/v1/users/login').send({ email, password });
    expect(relogin.statusCode).toBe(200);
    expect((await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${relogin.body.token}`)).statusCode).toBe(200);
  });
});
