// AES暗号化・復号化ユーティリティの自動テスト雛形（Jest）
const { encrypt, decrypt } = require('../../src/security/encryption');

describe('encryption', () => {
  it('平文→暗号化→復号化で元に戻る', () => {
    const plain = 'test string 123!@#';
    const enc = encrypt(plain);
    const dec = decrypt(enc);
    expect(dec).toBe(plain);
  });

  it('異なる平文は異なる暗号文になる', () => {
    const enc1 = encrypt('foo');
    const enc2 = encrypt('bar');
    expect(enc1).not.toBe(enc2);
  });
});
