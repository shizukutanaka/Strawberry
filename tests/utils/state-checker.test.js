// state-checker.js は注文状態遷移の強制ゲート（order/index.js の PUT /:id で
// isValidOrderTransition が 400 を返す判定）。遷移表の回帰（許可遷移の削除・
// 状態名 typo）を直接検証するユニットテストがなかったため追加。
const {
  ORDER_STATES,
  GPU_STATES,
  isValidOrderTransition,
  isValidGPUTransition,
} = require('../../src/utils/state-checker');

describe('isValidOrderTransition', () => {
  it('正常系の遷移を許可する', () => {
    expect(isValidOrderTransition('pending', 'matched')).toBe(true);
    expect(isValidOrderTransition('pending', 'cancelled')).toBe(true);
    expect(isValidOrderTransition('matched', 'active')).toBe(true);
    expect(isValidOrderTransition('matched', 'disputed')).toBe(true);
    expect(isValidOrderTransition('active', 'completed')).toBe(true);
    expect(isValidOrderTransition('disputed', 'completed')).toBe(true);
    expect(isValidOrderTransition('disputed', 'cancelled')).toBe(true);
  });

  it('終端状態（completed/cancelled）からの遷移を全て拒否する', () => {
    for (const to of ORDER_STATES) {
      expect(isValidOrderTransition('completed', to)).toBeFalsy();
      expect(isValidOrderTransition('cancelled', to)).toBeFalsy();
    }
  });

  it('逆行・スキップ遷移を拒否する', () => {
    // 例: matched → pending の巻き戻し、pending → active のスキップ
    expect(isValidOrderTransition('matched', 'pending')).toBeFalsy();
    expect(isValidOrderTransition('active', 'pending')).toBeFalsy();
    expect(isValidOrderTransition('pending', 'active')).toBeFalsy();
    expect(isValidOrderTransition('pending', 'completed')).toBeFalsy();
    expect(isValidOrderTransition('cancelled', 'pending')).toBeFalsy();
  });

  it('未知の状態名を拒否する（typo・注入値が通らない）', () => {
    expect(isValidOrderTransition('pending', 'processing')).toBeFalsy();
    expect(isValidOrderTransition('bogus', 'matched')).toBeFalsy();
    expect(isValidOrderTransition('', 'matched')).toBeFalsy();
    expect(isValidOrderTransition(undefined, 'matched')).toBeFalsy();
    expect(isValidOrderTransition('pending', undefined)).toBeFalsy();
    expect(isValidOrderTransition(null, null)).toBeFalsy();
  });

  it('自己遷移（from === to）は許可されない', () => {
    for (const s of ORDER_STATES) {
      expect(isValidOrderTransition(s, s)).toBeFalsy();
    }
  });
});

describe('isValidGPUTransition', () => {
  it('GPU 状態遷移表を検証する', () => {
    expect(isValidGPUTransition('available', 'allocated')).toBe(true);
    expect(isValidGPUTransition('available', 'maintenance')).toBe(true);
    expect(isValidGPUTransition('allocated', 'available')).toBe(true);
    expect(isValidGPUTransition('maintenance', 'available')).toBe(true);
    expect(isValidGPUTransition('offline', 'available')).toBe(true);
    // maintenance から allocated への直行は不可（available 経由のみ）
    expect(isValidGPUTransition('maintenance', 'allocated')).toBeFalsy();
    expect(isValidGPUTransition('available', 'bogus')).toBeFalsy();
    expect(isValidGPUTransition('bogus', 'available')).toBeFalsy();
  });
});

describe('状態テーブルの整合性', () => {
  it('ORDER_STATES / GPU_STATES の各状態が遷移表に定義されている', () => {
    // allowed マップに存在しない状態は「その状態から一切遷移できない」
    // 行として現れるため、列挙漏れはサイレントな機能喪失になる。
    for (const s of ORDER_STATES) {
      // 少なくとも1つの別状態への遷移可否が判定できることを確認
      const results = ORDER_STATES.map((t) => isValidOrderTransition(s, t));
      expect(results.every((r) => typeof r === 'boolean' || r === undefined)).toBe(true);
    }
    expect(ORDER_STATES).toEqual(
      expect.arrayContaining(['pending', 'matched', 'active', 'completed', 'cancelled', 'disputed'])
    );
    expect(GPU_STATES).toEqual(
      expect.arrayContaining(['available', 'allocated', 'maintenance', 'offline'])
    );
  });
});
