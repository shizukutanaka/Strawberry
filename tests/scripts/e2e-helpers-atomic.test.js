// tests/e2e/helpers.js の promoteToAdmin がアプリ側と同じ原子書込み
// （src/db/json/atomicWrite）で data/users.json を更新することを検証する。
// 非アトミックな writeFileSync では、起動中の e2e webServer が書き込み途中の
// 半壊 JSON を読み込み、以降の UserRepository 呼出しが連鎖的に失敗し得た。
const fs = require('fs');
const path = require('path');

jest.mock('../../src/db/json/atomicWrite', () => ({
  atomicWriteJSON: jest.fn(),
  atomicWriteString: jest.fn(),
}));

const { atomicWriteJSON } = require('../../src/db/json/atomicWrite');
const { promoteToAdmin } = require('../e2e/helpers');

const DATA_USERS = path.join(__dirname, '../../data/users.json');

const fakeRequest = (token = 'tok') => ({
  post: jest.fn(async () => ({ json: async () => ({ token }) })),
});

describe('tests/e2e/helpers.js promoteToAdmin', () => {
  beforeEach(() => {
    atomicWriteJSON.mockClear();
    // テスト用の実ファイルを直接シード（mock 済み atomicWriteJSON では書けないため fs 使用）
    fs.writeFileSync(DATA_USERS, JSON.stringify([
      { id: 'u-1', email: 'e2e@example.com', role: 'user' },
    ]));
  });

  afterEach(() => {
    fs.writeFileSync(DATA_USERS, '[]');
  });

  test('対象ユーザーを admin へ昇格し、atomicWriteJSON で永続化する', async () => {
    const token = await promoteToAdmin(fakeRequest(), 'http://localhost:3010', 'e2e@example.com', 'pw');
    expect(token).toBe('tok');
    expect(atomicWriteJSON).toHaveBeenCalledWith(
      DATA_USERS,
      expect.arrayContaining([expect.objectContaining({ email: 'e2e@example.com', role: 'admin' })]),
    );
  });

  test('存在しないユーザーはエラーで拒否し書き込まない', async () => {
    await expect(
      promoteToAdmin(fakeRequest(), 'http://localhost:3010', 'missing@example.com', 'pw'),
    ).rejects.toThrow('not found');
    expect(atomicWriteJSON).not.toHaveBeenCalled();
  });
});
