// KMS（Key Management Service）連携ユーティリティの自動テスト雛形（Jest）
const { KMSProvider } = require('../../src/security/kms');

describe('KMSProvider', () => {
  let kms;
  beforeEach(() => {
    kms = new KMSProvider();
  });

  it('getKeyで鍵を取得できる', async () => {
    const key = await kms.getKey('test-key-id');
    expect(typeof key).toBe('string');
  });

  it('createKeyで新規鍵を作成できる', async () => {
    const result = await kms.createKey({ usage: 'encrypt' });
    expect(result.keyId).toBeDefined();
    expect(result.usage).toBe('encrypt');
  });

  it('rotateKeyで鍵ローテーションできる', async () => {
    const result = await kms.rotateKey('test-key-id');
    expect(result).toBe(true);
  });
});
