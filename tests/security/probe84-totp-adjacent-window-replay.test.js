// tests/security/probe84-totp-adjacent-window-replay.test.js
// Probe 84 regression tests:
// master-auth の TOTP リプレイ対策が「現在ウィンドウのカウンタ比較」のみだった
// ため、window:1 の隣接ウィンドウ受理を利用した「前ウィンドウで受理された
// コードを次ウィンドウで再提示」するリプレイを防げなかった。
// 修正: 受理済みコード値自体を req.session.lastTotpToken に記録し、
// 同一値の再提示をウィンドウ跨ぎでも拒否する。

const fs = require('fs');
const speakeasy = require('speakeasy');

const SRC = fs.readFileSync(
  require.resolve('../../src/api/routes/master-auth.js'), 'utf-8'
);

describe('master-auth TOTP: adjacent-window replay prevention', () => {
  // 防衛の必要性を立証する前提テスト: window:1 は前ウィンドウのコードを受理する
  // （この受理こそが、カウンタ比較だけではリプレイを防げない理由）。
  it('speakeasy window:1 accepts a token from the previous 30s window', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    // 前ウィンドウ（30 秒前）のコードを生成し、現在時刻で検証する。
    // ウィンドウ境界に跨いでも成立するよう、現在ウィンドウの中盤を基準時刻に取る。
    const nowWindowStart = Math.floor(Date.now() / 30000) * 30000;
    const prevToken = speakeasy.totp({
      secret,
      encoding: 'base32',
      time: (nowWindowStart - 15000) / 1000, // 前ウィンドウ中盤
    });
    const ok = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: prevToken,
      time: nowWindowStart / 1000 + 15,    // 現ウィンドウ中盤
      window: 1,
    });
    expect(ok).toBe(true);
  });

  it('受理した TOTP コード値を session.lastTotpToken に記録する', () => {
    expect(SRC).toMatch(/req\.session\.lastTotpToken\s*=\s*token/);
  });

  it('受理済みコード値の再提示を verifyTOTP 呼出前に拒否する', () => {
    const tokenCheckIdx = SRC.indexOf('lastTotpToken === token');
    const verifyIdx = SRC.indexOf('verifyTOTP(');
    expect(tokenCheckIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(tokenCheckIdx).toBeLessThan(verifyIdx);
  });

  it('同一ウィンドウのカウンタガードも維持される（probe48 回帰）', () => {
    const counterCheckIdx = SRC.indexOf('lastTotpCounter === currentTotpCounter');
    const verifyIdx = SRC.indexOf('verifyTOTP(');
    expect(counterCheckIdx).toBeGreaterThan(-1);
    expect(counterCheckIdx).toBeLessThan(verifyIdx);
  });
});
