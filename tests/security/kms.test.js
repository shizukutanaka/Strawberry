// KMS（Key Management Service）連携ユーティリティの自動テスト
// probe 36b: KMS stub は実装なしで黙って返さず、明示的にエラーを投げる（fail-secure）。
const { KMSProvider } = require('../../src/security/kms');

describe('KMSProvider', () => {
  let kms;
  beforeEach(() => {
    kms = new KMSProvider();
  });

  it('getKey: 未実装時は例外を投げる（ダミー値でサイレントに成功しない）', async () => {
    await expect(kms.getKey('test-key-id')).rejects.toThrow(/KMS not configured/);
  });

  it('createKey: 未実装時は例外を投げる（ダミー keyId を返さない）', async () => {
    await expect(kms.createKey({ usage: 'encrypt' })).rejects.toThrow(/KMS not configured/);
  });

  it('rotateKey: 未実装時は例外を投げる（true を偽装しない）', async () => {
    await expect(kms.rotateKey('test-key-id')).rejects.toThrow(/KMS not configured/);
  });
});
