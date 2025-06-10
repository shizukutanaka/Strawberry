// RBACミドルウェア自動テスト雛形（Jest）
const rbac = require('../../../src/api/middleware/rbac');

function mockReq(role) {
  return { user: role ? { role } : undefined };
}
function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn()
  };
}
describe('RBACミドルウェア', () => {
  it('必要なロールで通過', () => {
    const req = mockReq('admin');
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(next).toBeCalled();
  });
  it('ロールなしで401', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(res.status).toBeCalledWith(401);
    expect(res.json).toBeCalledWith({ error: '認証情報がありません' });
  });
  it('権限不足で403', () => {
    const req = mockReq('user');
    const res = mockRes();
    const next = jest.fn();
    rbac('admin')(req, res, next);
    expect(res.status).toBeCalledWith(403);
    expect(res.json).toBeCalledWith({ error: '権限がありません' });
  });
  it('複数ロール許可（配列）で通過', () => {
    const req = mockReq('editor');
    const res = mockRes();
    const next = jest.fn();
    rbac(['admin', 'editor'])(req, res, next);
    expect(next).toBeCalled();
  });
});
