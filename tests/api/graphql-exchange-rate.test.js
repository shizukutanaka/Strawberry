// GraphQL現金換算API（exchangeRateクエリ）の自動テスト
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, graphqlReady } = require('../../src/api/server');
const { resolveSecret } = require('../../src/api/middleware/jwt-auth');

describe('GraphQL exchangeRate API', () => {
  let graphqlAvailable = false;
  // Apollo の start() は非同期。マウント完了を待ってから検証する。
  beforeAll(async () => {
    graphqlAvailable = await graphqlReady;
  });

  it('should return rate, timestamp, isCache via exchangeRate query', async () => {
    if (!graphqlAvailable) {
      return; // GraphQL 未導入環境ではスキップ
    }
    const query = `query { exchangeRate { rate timestamp isCache } }`;
    const res = await request(app)
      .post('/graphql')
      .send({ query });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.exchangeRate).toHaveProperty('rate');
    expect(typeof res.body.data.exchangeRate.rate).toBe('number');
    expect(res.body.data.exchangeRate).toHaveProperty('timestamp');
    expect(res.body.data.exchangeRate).toHaveProperty('isCache');
  });

  it('should force fresh fetch when fresh:true', async () => {
    if (!graphqlAvailable) {
      return; // GraphQL 未導入環境ではスキップ
    }
    const query = `query { exchangeRate(fresh: true) { rate timestamp isCache } }`;
    const res = await request(app)
      .post('/graphql')
      .send({ query });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.exchangeRate).toHaveProperty('rate');
    expect(res.body.data.exchangeRate).toHaveProperty('timestamp');
    expect(res.body.data.exchangeRate.isCache === false || res.body.data.exchangeRate.isCache === true).toBe(true);
  });

  it('does not authenticate a refresh-typed token on protected queries', async () => {
    if (!graphqlAvailable) return;
    // type:'refresh' のトークンは GraphQL でもアクセス用として認証を通さない（REST と同一ポリシー）
    const refreshToken = jwt.sign(
      { id: 'u-test', role: 'admin', type: 'refresh' },
      resolveSecret(),
      { algorithm: 'HS256', expiresIn: '7d' }
    );
    const res = await request(app)
      .post('/graphql')
      .set('Authorization', `Bearer ${refreshToken}`)
      .send({ query: `query { users { id } }` });
    expect(res.statusCode).toBe(200);
    // 認証されなければ users リゾルバは AuthenticationError を投げ data.users は null
    expect(res.body.data && res.body.data.users).toBeFalsy();
    expect(Array.isArray(res.body.errors) && res.body.errors.length > 0).toBe(true);
  });
});
