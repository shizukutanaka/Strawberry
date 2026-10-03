// authenticateJWT の失効トークン拒否 → セキュリティインシデント記録の契約を固定する。
// 失効 jti の再提示は盗用/リプレイの兆候 — 同一 jti では 1 プロセスあたり 1 度のみ
// 記録され、別 jti の試行のみが連続して証跡に残る。
const jwt = require('jsonwebtoken');

jest.mock('../../../src/api/middleware/token-denylist', () => ({
  isRevoked: jest.fn(),
}));
jest.mock('../../../src/security/incident', () => ({
  recordIncident: jest.fn(),
}));
jest.mock('../../../src/db/json/UserRepository', () => ({
  getById: (id) => ({ id, role: 'user', status: 'active' }),
  getAll: () => [{ id: 'u1', role: 'user', status: 'active' }],
}));

const { authenticateJWT } = require('../../../src/api/middleware/security');
const { isRevoked } = require('../../../src/api/middleware/token-denylist');
const { recordIncident } = require('../../../src/security/incident');

const SECRET = 'test_secret_0123456789abcdef0123456789abcdef';
const jti = () => `jti-${Math.random().toString(36).slice(2)}`;

function run(jtiValue) {
  const token = jwt.sign({ id: 'u1', jti: jtiValue }, SECRET, { expiresIn: '1h' });
  const req = { headers: { authorization: `Bearer ${token}` }, ip: '1.2.3.4' };
  const next = jest.fn();
  authenticateJWT(req, {}, next);
  return next;
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});

beforeEach(() => {
  isRevoked.mockReset();
  recordIncident.mockClear();
});

describe('authenticateJWT: 失効トークンのインシデント記録', () => {
  it('失効 jti の提示を 401 で拒否し recordIncident へ記録する', () => {
    isRevoked.mockReturnValue(true);
    const j = jti();
    const next = run(j);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect(recordIncident).toHaveBeenCalledTimes(1);
    expect(recordIncident).toHaveBeenCalledWith(
      'revoked_token_reuse',
      expect.objectContaining({ userId: 'u1', jti: j, ip: '1.2.3.4' })
    );
  });

  it('同一 jti の繰返しは重複記録しない（stale client の通常リトライを抑制）', () => {
    isRevoked.mockReturnValue(true);
    const j = jti();
    run(j);
    run(j);
    expect(recordIncident).toHaveBeenCalledTimes(1);
  });

  it('異なる失効 jti の試行はそれぞれ記録される', () => {
    isRevoked.mockReturnValue(true);
    run(jti());
    run(jti());
    expect(recordIncident).toHaveBeenCalledTimes(2);
  });

  it('未失効トークンは記録せず通過する', () => {
    isRevoked.mockReturnValue(false);
    const next = run(jti());
    expect(next).toHaveBeenCalledWith();
    expect(recordIncident).not.toHaveBeenCalled();
  });
});
