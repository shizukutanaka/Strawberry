// tests/api/middleware/audit-log-cap.test.js
// 監査ミドルウェアの耐性テスト:
//  - 巨大な response/body は全文ではなく {_truncated, bytes} として記録する
//  - 深くネストしたオブジェクトで sanitize がスタックオーバーフローしない
//  - mkdirSync は初回の書き込み時のみ呼ばれる
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpLog = path.join(os.tmpdir(), `audit-test-${process.pid}.log`);
process.env.AUDIT_LOG_PATH = tmpLog;

const auditLogger = require('../../../src/api/middleware/audit');
const { sanitizeSensitiveFields } = require('../../../src/utils/sanitize');

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.json = jest.fn();
  return res;
}

function lastEntry() {
  const lines = fs.readFileSync(tmpLog, 'utf-8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('auditLogger field capping', () => {
  beforeEach(() => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  });
  afterAll(() => {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  });

  it('records a small response after masking sensitive fields', () => {
    const req = { method: 'POST', originalUrl: '/x', ip: '1.2.3.4', query: {}, body: { password: 'p', v: 1 }, user: { id: 'u1' } };
    const res = makeRes();
    auditLogger(req, res, () => {});
    res.json({ ok: true, accessToken: 'secret-jwt' });
    const entry = lastEntry();
    expect(entry.response).toEqual({ ok: true, accessToken: '[MASKED]' });
    expect(entry.body).toEqual({ password: '[MASKED]', v: 1 });
    expect(entry.status).toBe(200);
  });

  it('truncates oversized responses instead of writing full payload', () => {
    const big = { data: 'x'.repeat(5000) };
    const req = { method: 'GET', originalUrl: '/big', ip: '1.2.3.4', query: {}, user: { id: 'u1' } };
    const res = makeRes();
    auditLogger(req, res, () => {});
    res.json(big);
    const entry = lastEntry();
    expect(entry.response._truncated).toBe(true);
    expect(entry.response.bytes).toBeGreaterThan(2048);
    expect(JSON.stringify(entry.response)).not.toContain('xxxxx');
  });

  it('survives deeply nested bodies without stack overflow', () => {
    let deep = { end: true };
    for (let i = 0; i < 500; i++) deep = { a: deep };
    const req = { method: 'POST', originalUrl: '/deep', ip: '1.2.3.4', query: {}, body: deep, user: {} };
    const res = makeRes();
    expect(() => auditLogger(req, res, () => {})).not.toThrow();
    res.json({ ok: true });
    expect(lastEntry().status).toBe(200);
  });

  it('mkdir runs only once across multiple writes', () => {
    const spy = jest.spyOn(fs, 'mkdirSync');
    const req = { method: 'GET', originalUrl: '/m', ip: '1.2.3.4', query: {}, user: {} };
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      auditLogger(req, res, () => {});
      res.json({ i });
    }
    // _logDirReady はモジュール初回書き込みで立つため、本テスト内では 0 回
    // （既に他テストで書き込み済みなら mkdir 自体が呼ばれない）
    const calls = spy.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1);
    spy.mockRestore();
  });
});

describe('sanitizeSensitiveFields depth cap', () => {
  it('returns [TRUNCATED] beyond the depth limit', () => {
    let deep = { secret: 's' };
    for (let i = 0; i < 40; i++) deep = { a: deep };
    const out = sanitizeSensitiveFields(deep);
    // 例外なく返り、最深部は '[TRUNCATED]' で打ち止め
    let cur = out;
    for (let i = 0; i < 32; i++) cur = cur.a;
    expect(cur).toBe('[TRUNCATED]');
  });
});
