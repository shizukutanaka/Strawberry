// API統合テスト雛形（Jest + supertest）
const request = require('supertest');
const app = require('../src/app'); // Expressアプリ本体

describe('API Integration Tests', () => {
  describe('User API', () => {
    it('should register a new user', async () => {
      const res = await request(app)
        .post('/api/users/register')
        .send({
          username: 'testuser',
          email: 'testuser@example.com',
          password: 'Test1234!'
        });
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('user');
    });
    // ...他のユーザーAPIテスト
  });

  describe('GPU API', () => {
    it('should get GPU list', async () => {
      const res = await request(app)
        .get('/api/gpus');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('gpus');
    });
    // ...他のGPU APIテスト
  });

  describe('Order API', () => {
    it('should reject unauthenticated order creation', async () => {
      const res = await request(app)
        .post('/api/orders')
        .send({});
      expect(res.statusCode).toBe(401);
    });
    // ...他の注文APIテスト
  });

  describe('Payment API', () => {
    it('should reject payment without auth', async () => {
      const res = await request(app)
        .post('/api/payments/invoice')
        .send({});
      expect(res.statusCode).toBe(401);
    });
    // ...他の決済APIテスト
  });
});
