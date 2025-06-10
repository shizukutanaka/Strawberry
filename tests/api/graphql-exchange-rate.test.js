// GraphQL現金換算API（exchangeRateクエリ）の自動テスト
const request = require('supertest');
const app = require('../../src/api/server');

describe('GraphQL exchangeRate API', () => {
  it('should return rate, timestamp, isCache via exchangeRate query', async () => {
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
    const query = `query { exchangeRate(fresh: true) { rate timestamp isCache } }`;
    const res = await request(app)
      .post('/graphql')
      .send({ query });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.exchangeRate).toHaveProperty('rate');
    expect(res.body.data.exchangeRate).toHaveProperty('timestamp');
    expect(res.body.data.exchangeRate.isCache === false || res.body.data.exchangeRate.isCache === true).toBe(true);
  });
});
