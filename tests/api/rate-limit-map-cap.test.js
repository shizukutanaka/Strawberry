// レート制限カウンタ Map の増殖上限を検証。
// user/index.js の _loginFailures（任意メールキー）と
// master-auth.js の _totpIpMap（任意 IP キー）は未認証入力をキーにするため、
// 一撃アクセスが無制限に蓄積し得る → 挿入順プルーニングで上限化。
const userRoutes = require('../../src/api/routes/user/index.js');
const masterAuth = require('../../src/api/routes/master-auth.js');

const CAP = 10_000;

describe('レート制限 Map の増殖上限', () => {
  afterEach(() => {
    userRoutes._loginFailures.clear();
    masterAuth._totpIpMap.clear();
  });

  test('loginFailures: 上限到達後の新規キーは最古エントリを追い出す', () => {
    const map = userRoutes._loginFailures;
    for (let i = 0; i < CAP; i++) map.set(`seed-${i}@x.example`, { count: 1, windowStart: Date.now() });
    userRoutes._recordLoginFailure('new@x.example');
    expect(map.size).toBe(CAP);
    expect(map.has('seed-0@x.example')).toBe(false); // 最古を追い出し
    expect(map.get('new@x.example').count).toBe(1);
  });

  test('loginFailures: 既存キーの再失敗は追い出しを起こさずカウント加算', () => {
    const map = userRoutes._loginFailures;
    for (let i = 0; i < CAP; i++) map.set(`seed-${i}@x.example`, { count: 1, windowStart: Date.now() });
    const n = userRoutes._recordLoginFailure('seed-0@x.example');
    expect(n).toBe(2);
    expect(map.size).toBe(CAP); // 新規キーでなければ追い出しなし
    expect(map.has('seed-0@x.example')).toBe(true);
  });

  test('totpIpMap: 上限到達後の新規 IP は最古エントリを追い出す', () => {
    const map = masterAuth._totpIpMap;
    for (let i = 0; i < CAP; i++) map.set(`10.0.${i >> 8}.${i & 255}`, { count: 1, windowStart: Date.now() });
    masterAuth._checkTotpIpLimit('192.0.2.1');
    expect(map.size).toBe(CAP);
    expect(map.has('10.0.0.0')).toBe(false);
    expect(map.get('192.0.2.1').count).toBe(1);
  });

  test('totpIpMap: 上限後でも同一 IP の継続試行は rate-limit 判定が働く', () => {
    const map = masterAuth._totpIpMap;
    for (let i = 0; i < CAP; i++) map.set(`10.1.${i >> 8}.${i & 255}`, { count: 1, windowStart: Date.now() });
    // 同一 IP の継続試行で TOTP_IP_MAX(10) 超過 → true
    let limited = false;
    for (let i = 0; i < 12; i++) limited = masterAuth._checkTotpIpLimit('192.0.2.2') || limited;
    expect(limited).toBe(true);
  });
});
