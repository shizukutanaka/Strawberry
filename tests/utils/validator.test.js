// バリデーションユーティリティの自動テスト雛形（Jest）
const { schemas, validate, isUUID } = require('../../src/utils/validator');

describe('validator', () => {
  it('GPU登録スキーマ: 正常系', () => {
    const data = {
      id: 'gpu-123',
      name: 'RTX 3090',
      vendor: 'NVIDIA',
      memoryGB: 24,
      clockMHz: 1700,
      powerWatt: 350,
      pricePerHour: 0.5
    };
    const { error } = schemas.gpu.register.validate(data);
    expect(error).toBeUndefined();
  });

  it('GPU登録スキーマ: 異常系', () => {
    const data = { name: '', vendor: '', memoryGB: 0 };
    const { error } = schemas.gpu.register.validate(data);
    expect(error).toBeTruthy();
  });

  it('ユーザー登録スキーマ: 正常系', () => {
    const data = {
      username: 'user1',
      email: 'test@example.com',
      password: 'Passw0rd!'
    };
    const { error } = schemas.user.register.validate(data);
    expect(error).toBeUndefined();
  });

  it('ユーザー登録スキーマ: 異常系', () => {
    const data = { username: 'a', email: 'bad', password: '' };
    const { error } = schemas.user.register.validate(data);
    expect(error).toBeTruthy();
  });

  it('isUUID: 正しいUUID', () => {
    expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('isUUID: 不正なUUID', () => {
    expect(isUUID('not-a-uuid')).toBe(false);
  });
});
