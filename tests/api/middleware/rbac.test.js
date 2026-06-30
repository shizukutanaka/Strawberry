// RBACミドルウェアテスト
const rbac = require('../../../src/api/middleware/rbac');
const { APIError, ErrorTypes } = require('../../../src/utils/error-handler');

function mockReq(role) {
  return { user: role !== undefined ? { role } : undefined };
}
function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  };
}

describe('RBACミドルウェア — 基本動作', () => {
  it('必要なロールで通過', () => {
    const req = mockReq('admin');
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(next).toBeCalledWith(); // エラー引数なし
  });

  it('ロールなしで next(APIError 401)', () => {
    const req = { user: undefined };
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(next).toBeCalledWith(expect.any(APIError));
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.type).toBe(ErrorTypes.UNAUTHORIZED);
  });

  it('権限不足で next(APIError 403)', () => {
    const req = mockReq('user');
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(next).toBeCalledWith(expect.any(APIError));
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.type).toBe(ErrorTypes.FORBIDDEN);
  });

  it('複数ロール許可（配列）で通過', () => {
    const req = mockReq('editor');
    const res = mockRes();
    const next = jest.fn();
    rbac(['admin', 'editor'])(req, res, next);
    expect(next).toBeCalledWith(); // エラー引数なし
  });

  it('複数ロール許可（配列）で権限不足なら403', () => {
    const req = mockReq('user');
    const res = mockRes();
    const next = jest.fn();
    rbac(['admin', 'editor'])(req, res, next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});

describe('RBACミドルウェア — role型強制（型混同バイパス防止）', () => {
  it('role が配列 (["admin"]) なら403（型混同バイパス不可）', () => {
    const req = { user: { role: ['admin'] } };
    const next = jest.fn();
    rbac('admin')(req, mockRes(), next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role がオブジェクト ({value:"admin"}) なら403', () => {
    const req = { user: { role: { value: 'admin' } } };
    const next = jest.fn();
    rbac('admin')(req, mockRes(), next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role が数値 (1) なら403', () => {
    const req = { user: { role: 1 } };
    const next = jest.fn();
    rbac('admin')(req, mockRes(), next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('role が null なら401（falsy → 認証なし扱い）', () => {
    const req = { user: { role: null } };
    const next = jest.fn();
    rbac('admin')(req, mockRes(), next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it('配列requiredRoleでも非文字列roleは403', () => {
    const req = { user: { role: ['admin', 'editor'] } };
    const next = jest.fn();
    rbac(['admin', 'editor'])(req, mockRes(), next);
    expect(next).toBeCalledWith(expect.any(APIError));
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});
