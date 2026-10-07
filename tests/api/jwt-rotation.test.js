// tests/api/jwt-rotation.test.js — JWT_SECRET_PREVIOUS ローテーション猶予の
// 契約を固定するテスト（弱所#15）。旧鍵署名トークンが猶予期間中も検証を
// 通り、新鍵への移行を無停止で行えることを検証する。
const jwt = require('jsonwebtoken');
const { verifyWithRotation } = require('../../src/api/middleware/jwt-auth');

const NEW_SECRET = 'new-secret-for-rotation-test-at-least-32c';
const OLD_SECRET = 'old-secret-for-rotation-test-at-least-32c';
const NEW_REFRESH = 'new-refresh-secret-rotation-test-32chars';
const OLD_REFRESH = 'old-refresh-secret-rotation-test-32chars';

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_SECRET_PREVIOUS', 'JWT_REFRESH_SECRET_PREVIOUS']) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});
afterAll(() => { Object.assign(process.env, savedEnv); });

function setup({ access, refresh, prevAccess, prevRefresh }) {
  process.env.JWT_SECRET = access;
  if (refresh === undefined) delete process.env.JWT_REFRESH_SECRET;
  else process.env.JWT_REFRESH_SECRET = refresh;
  if (prevAccess === undefined) delete process.env.JWT_SECRET_PREVIOUS;
  else process.env.JWT_SECRET_PREVIOUS = prevAccess;
  if (prevRefresh === undefined) delete process.env.JWT_REFRESH_SECRET_PREVIOUS;
  else process.env.JWT_REFRESH_SECRET_PREVIOUS = prevRefresh;
}

describe('verifyWithRotation — 鍵ローテーション猶予', () => {
  test('新鍵署名トークンは常に検証を通る', () => {
    setup({ access: NEW_SECRET, prevAccess: OLD_SECRET });
    const t = jwt.sign({ id: 'u1' }, NEW_SECRET, { algorithm: 'HS256' });
    expect(verifyWithRotation(t).id).toBe('u1');
  });

  test('旧鍵署名トークンは JWT_SECRET_PREVIOUS 設定時のみ検証を通る', () => {
    const t = jwt.sign({ id: 'u2' }, OLD_SECRET, { algorithm: 'HS256' });
    setup({ access: NEW_SECRET }); // previous 未設定 → 拒否
    expect(() => verifyWithRotation(t)).toThrow();
    setup({ access: NEW_SECRET, prevAccess: OLD_SECRET }); // 猶予あり → 受理
    expect(verifyWithRotation(t).id).toBe('u2');
  });

  test('カンマ区切りで複数の旧鍵を受け付ける（段階的ローテーション）', () => {
    const t = jwt.sign({ id: 'u3' }, OLD_SECRET, { algorithm: 'HS256' });
    setup({ access: NEW_SECRET, prevAccess: `other-secret, ${OLD_SECRET} , another` });
    expect(verifyWithRotation(t).id).toBe('u3');
  });

  test('refresh: true は JWT_REFRESH_SECRET_PREVIOUS を使いアクセス側リストと混ざらない', () => {
    const t = jwt.sign({ id: 'u4', type: 'refresh' }, OLD_REFRESH, { algorithm: 'HS256' });
    // アクセス側の PREVIOUS に入れても refresh 検証には効かない（クロスタイプ防止）
    setup({ access: NEW_SECRET, refresh: NEW_REFRESH, prevAccess: OLD_REFRESH });
    expect(() => verifyWithRotation(t, { refresh: true })).toThrow();
    setup({ access: NEW_SECRET, refresh: NEW_REFRESH, prevRefresh: OLD_REFRESH });
    expect(verifyWithRotation(t, { refresh: true }).id).toBe('u4');
  });

  test('JWT_REFRESH_SECRET 未設定（鍵共用）時は JWT_SECRET_PREVIOUS が refresh 検証にも効く', () => {
    const t = jwt.sign({ id: 'u5', type: 'refresh' }, OLD_SECRET, { algorithm: 'HS256' });
    setup({ access: NEW_SECRET, refresh: undefined, prevAccess: OLD_SECRET });
    expect(verifyWithRotation(t, { refresh: true }).id).toBe('u5');
  });

  test('全鍵失敗時はエラーを投げる（旧来の jwt.verify 失敗と同じ契約）', () => {
    setup({ access: NEW_SECRET, prevAccess: 'irrelevant' });
    expect(() => verifyWithRotation('not-a-token')).toThrow();
  });
});
