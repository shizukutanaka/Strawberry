// 提供者エージェントの「放置しても貸し続けられる」性質を実ソケットで固定する:
//   - サーバ停止が初期バックオフ（1s+2s）より長く続いても、再起動後に自動で再接続する
//   - 専用のエージェントトークンはアクセストークンの短い有効期限を越えて接続できる
//   - エージェントトークンは中継の接続専用で、REST API の認証には使えない（最小権限）
//   - トークンが失効したら再接続を無限に試さず、理由つきで停止する
const http = require('http');
const request = require('supertest');
const { app, graphqlReady } = require('../../src/api/server');
const { hub } = require('../../src/services/provider-agent-hub');
const { connectClient } = require('../../src/services/ws-rfc6455');
const { createProviderAgent } = require('../../agent/provider-agent');
const UserRepository = require('../../src/db/json/UserRepository');

function decodeUserId(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).id;
}

async function registerAndLogin(suffix) {
  const email = `durable${suffix}@example.com`;
  const password = 'TestPass123!';
  await request(app).post('/api/v1/users/register')
    .send({ username: `durable${suffix}`, email, password, role: 'provider' });
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  return { accessToken: login.body.token, userId: decodeUserId(login.body.token) };
}

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function startHubServer(port = 0) {
  const server = http.createServer();
  hub.attachToServer(server);
  return listen(server, port).then(() => server);
}

function closeServer(server) {
  hub.closeAll();
  return new Promise((r) => server.close(r));
}

async function issueAgentToken(accessToken) {
  const res = await request(app).post('/api/v1/users/me/agent-token')
    .set('Authorization', `Bearer ${accessToken}`);
  return res;
}

describe('durable provider agent', () => {
  const suffix = `${Date.now()}`;
  let provider;

  beforeAll(async () => {
    provider = await registerAndLogin(suffix);
  });

  afterEach(() => hub.closeAll());

  it('reconnects after a server outage longer than the first backoff steps', async () => {
    let server = await startHubServer();
    const port = server.address().port;
    const agent = createProviderAgent({
      serverUrl: `http://127.0.0.1:${port}`,
      token: provider.accessToken,
      upstreamUrl: 'http://127.0.0.1:9',
    });
    try {
      await agent.start();
      await waitFor(() => hub.hasProvider(provider.userId));

      await closeServer(server);
      await waitFor(() => !agent.isConnected());
      // 1s 後と 3s 後の再接続はどちらも失敗する長さだけ止めておく
      await new Promise((r) => setTimeout(r, 4500));
      server = await startHubServer(port);

      // サーバ側の登録はクライアントのハンドシェイク完了より先に起きるため両方を待つ
      await waitFor(() => hub.hasProvider(provider.userId) && agent.isConnected(), 15000);
      expect(agent.isConnected()).toBe(true);
    } finally {
      agent.stop();
      await closeServer(server);
    }
  }, 30000);

  it('issues an agent token that keeps connecting after the access token has expired', async () => {
    const prev = process.env.JWT_EXPIRES_IN;
    process.env.JWT_EXPIRES_IN = '1s';
    let shortLived;
    try {
      shortLived = await registerAndLogin(`short${suffix}`);
    } finally {
      if (prev === undefined) delete process.env.JWT_EXPIRES_IN; else process.env.JWT_EXPIRES_IN = prev;
    }
    const issued = await issueAgentToken(shortLived.accessToken);
    expect(issued.status).toBe(201);
    expect(typeof issued.body.token).toBe('string');
    expect(issued.body.expiresIn).toBeTruthy();

    await new Promise((r) => setTimeout(r, 2100));
    const server = await startHubServer();
    const wsUrl = `ws://127.0.0.1:${server.address().port}/api/v1/agent/connect`;
    try {
      await expect(connectClient(wsUrl, { headers: { Authorization: `Bearer ${shortLived.accessToken}` } }))
        .rejects.toThrow(/401/);
      const ws = await connectClient(wsUrl, { headers: { Authorization: `Bearer ${issued.body.token}` } });
      await waitFor(() => hub.hasProvider(shortLived.userId));
      ws.close();
    } finally {
      await closeServer(server);
    }
  });

  it('agent tokens cannot authenticate the REST or GraphQL API', async () => {
    const issued = await issueAgentToken(provider.accessToken);
    expect(issued.status).toBe(201);
    const me = await request(app).get('/api/v1/users/me')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(me.status).toBe(401);
    const gpus = await request(app).get('/api/v1/gpus/my')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(gpus.status).toBe(401);
    if (await graphqlReady) {
      const gql = await request(app).post('/graphql')
        .set('Authorization', `Bearer ${issued.body.token}`)
        .send({ query: 'query { orders { id } }' });
      expect(gql.body.errors && gql.body.errors.length).toBeTruthy();
      expect(gql.body.data == null || gql.body.data.orders == null).toBe(true);
    }
    // エージェントトークンで新しいエージェントトークンを発行できない（自己延命の防止）
    const chained = await issueAgentToken(issued.body.token);
    expect(chained.status).toBe(401);
  });

  it('requires authentication to issue an agent token', async () => {
    const res = await request(app).post('/api/v1/users/me/agent-token');
    expect(res.status).toBe(401);
  });

  it('stops retrying with a reason once the server rejects the token', async () => {
    const own = await registerAndLogin(`revoked${suffix}`);
    const issued = await issueAgentToken(own.accessToken);
    const server = await startHubServer();
    let gaveUp = null;
    const agent = createProviderAgent({
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      token: issued.body.token,
      upstreamUrl: 'http://127.0.0.1:9',
      onGiveUp: (err) => { gaveUp = err; },
    });
    try {
      await agent.start();
      await waitFor(() => hub.hasProvider(own.userId));
      // 全セッション失効（パスワード変更等と同じ境界）→ 切断 → 再接続は 401
      await new Promise((r) => setTimeout(r, 1100));
      UserRepository.update(own.userId, { sessionsRevokedAt: new Date().toISOString() });
      hub.closeAll();
      await waitFor(() => gaveUp !== null, 10000);
      expect(String(gaveUp.message)).toMatch(/401/);
      expect(agent.isConnected()).toBe(false);
    } finally {
      agent.stop();
      await closeServer(server);
    }
  }, 20000);
});
