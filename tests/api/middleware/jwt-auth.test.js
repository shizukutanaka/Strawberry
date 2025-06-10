// JWT認証ミドルウェア自動テスト雛形（Jest）
const jwt = require('jsonwebtoken');
const jwtAuth = require('../../../src/api/middleware/jwt-auth');

const SECRET = 'test_secret';
const userPayload = { id: 1, role: 'admin' };
const token = jwt.sign(userPayload, SECRET);

function mockReq(token) {
  return {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
  };
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  };
}

describe('JWT認証ミドルウェア', () => {
  it('有効なトークンで通過', () => {
    const req = mockReq(jwt.sign(userPayload, SECRET));
    const res = mockRes();
    const next = jest.fn();
    process.env.JWT_SECRET = SECRET;
    jwtAuth(req, res, next);
    expect(req.user.id).toBe(1);
    expect(next).toBeCalled();
  });

  it('トークンなしで401', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    jwtAuth(req, res, next);
    expect(res.status).toBeCalledWith(401);
    expect(res.json).toBeCalledWith({ error: '認証トークンがありません' });
  });

  it('無効なトークンで401', () => {
    const req = mockReq('invalid');
    const res = mockRes();
    const next = jest.fn();
    process.env.JWT_SECRET = SECRET;
    jwtAuth(req, res, next);
    expect(res.status).toBeCalledWith(401);
    expect(res.json).toBeCalledWith({ error: '無効なトークン' });
  });
});
