// scripts/prepare-data.js のサンプルデータが実スキーマ適合かつ非稼働（inert）である
// ことを保証するガード。以前のサンプルは vendor/apiType/pricePerHour/providerId 欠落の
// status:'available' な GPU を seed し、GET /api/v1/gpus?vendor=… で
// gpu.vendor.toLowerCase() の TypeError(500) と価格計算不能な出品を発生させた。
const { files } = require('../../scripts/prepare-data');
const { schemas } = require('../../src/utils/validator');

const byName = (name) => files.find((f) => f.name === name);

describe('prepare-data サンプルの健全性', () => {
  it('gpu.json のサンプルが実登録スキーマの必須項目を満たし、かつ maintenance（非出品）である', () => {
    const gpus = byName('gpus.json').sample;
    expect(gpus.length).toBeGreaterThan(0);
    // register スキーマはリクエストボディ用のため、保存レコードの id/status 等の
    // 追加キーは unknown として弾かれる。登録時に検証される必須項目の部分集合を検証する。
    const REGISTER_KEYS = [
      'name', 'vendor', 'model', 'apiType', 'driverVersion', 'os',
      'arch', 'memoryGB', 'clockMHz', 'powerWatt', 'pricePerHour',
    ];
    for (const gpu of gpus) {
      const subset = Object.fromEntries(REGISTER_KEYS.map((k) => [k, gpu[k]]));
      const { error } = schemas.gpu.register.validate(subset);
      expect(error).toBeUndefined();
      expect(gpu.providerId).toBeTruthy();
      // 'available' にすると注文フロー・占有判定に混入する
      expect(gpu.status).not.toBe('available');
    }
  });

  it('orders.json のサンプルが終端状態（pending 系タイムアウト対象外）である', () => {
    const orders = byName('orders.json').sample;
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      // pending/matched/active は失効スイープ・占有判定・支払い導線に混入する
      expect(['completed', 'cancelled']).toContain(o.status);
      expect(o.totalPrice).toEqual(expect.any(Number));
      expect(Number.isFinite(Date.parse(o.createdAt))).toBe(true);
    }
  });

  it('users.json のサンプルは username を持ち passwordHash を持たない（ログイン不可）', () => {
    const users = byName('users.json').sample;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) {
      expect(u.username).toBeTruthy();
      // passwordHash 付きの既知パスワード持ちデモアカウントは認証バックドアになる
      expect(u.passwordHash).toBeUndefined();
      expect(u.password).toBeUndefined();
    }
  });

  it('全サンプルレコードに demo:true マーカーがある（本番データと識別可能）', () => {
    for (const f of files) {
      for (const rec of f.sample) {
        expect(rec.demo).toBe(true);
      }
    }
  });
});
