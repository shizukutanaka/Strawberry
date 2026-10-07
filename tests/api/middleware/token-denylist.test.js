// token-denylist の stat ゲート再読込（クロスプロセス失効伝播）テスト。
// 以前は初回ロード後に Map が固定され、別プロセス/CLI が revoked-tokens.json を
// 更新してもこのプロセスの isRevoked が古いマップを見続けていた。
const fs = require('fs');
const path = require('path');

const { resolveDataDir } = require('../../../src/db/json/data-dir');
const DENYLIST = path.join(resolveDataDir(), 'revoked-tokens.json');
const { revoke, isRevoked } = require('../../../src/api/middleware/token-denylist');

describe('token-denylist', () => {
  afterAll(() => {
    // 共有データファイルを他スイートに汚染しないよう復元
    try { fs.writeFileSync(DENYLIST, '{}', 'utf-8'); } catch (_) {}
  });

  it('revoke + isRevoked: in-process round trip', () => {
    expect(isRevoked('local-jti')).toBe(false);
    revoke('local-jti', Date.now() + 60_000);
    expect(isRevoked('local-jti')).toBe(true);
  });

  it('expired entries are treated as not revoked', () => {
    revoke('stale-jti', Date.now() + 60_000);
    // 直接ファイルを書き換えて期限切れエントリを作る（revoke は過去 exp を 24h に矯正するため）
    fs.writeFileSync(DENYLIST, JSON.stringify({ 'stale-jti': Date.now() - 1000 }));
    expect(isRevoked('stale-jti')).toBe(false);
  });

  it('reloads the denylist when another process rewrites the file', () => {
    // 初回ロード（空 or revoke済みの状態）を確定
    isRevoked('external-jti');
    // 別プロセスが追記した状況をファイル直接書き換えで再現
    fs.writeFileSync(DENYLIST, JSON.stringify({ 'external-jti': Date.now() + 60_000 }));
    expect(isRevoked('external-jti')).toBe(true);
  });

  it('keeps enforcing cached revocations when the file becomes unparseable', () => {
    // 破損した更新が既存の失効キャッシュを捨てないこと（Devin Review #70 指摘回帰）
    revoke('kept-jti', Date.now() + 60_000);
    expect(isRevoked('kept-jti')).toBe(true);
    fs.writeFileSync(DENYLIST, '{ not valid json');
    expect(isRevoked('kept-jti')).toBe(true);
  });

  it('does not reload while the file is unchanged', () => {
    revoke('cached-jti', Date.now() + 60_000); // load + persist → ファイル更新
    isRevoked('cached-jti'); // persist による変更を拾う再読込（指紋が確定する）
    const spy = jest.spyOn(fs, 'readFileSync');
    isRevoked('cached-jti');
    isRevoked('other-jti');
    const denylistReads = spy.mock.calls.filter(
      (c) => String(c[0]).endsWith('revoked-tokens.json')
    ).length;
    expect(denylistReads).toBe(0);
    spy.mockRestore();
  });

  it('prunes expired entries from the file (amortized GC)', () => {
    // ファイルに期限切れエントリを直接書く（revoke は過去 exp を 24h 矯正するため）。
    // GC の persist は 60s 間隔で amortize されるため、直前テストで時計が進め済みでも
    // 間隔を超過したことにする（Date.now を +61s 進める）。
    const realNow = Date.now;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
    fs.writeFileSync(DENYLIST, JSON.stringify({
      'expired-a': realNow() - 1000,
      'expired-b': realNow() - 2000,
      'live-jti': realNow() + 300_000, // +61s 進めても未期限切れ
    }));
    try {
      expect(isRevoked('expired-a')).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
    const persisted = JSON.parse(fs.readFileSync(DENYLIST, 'utf-8'));
    expect(persisted['expired-a']).toBeUndefined();
    expect(persisted['expired-b']).toBeUndefined();
    expect(persisted['live-jti']).toBeDefined(); // 有効エントリは保持
  });
});
