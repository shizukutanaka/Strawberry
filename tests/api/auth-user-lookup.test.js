// 認証ルックアップキャッシュ (src/api/utils/auth-user-lookup.js) の検証。
// - users.json 変更時のみ再パースされる（stat ゲート）
// - 返却物は認証判定に必要なフィールドのみで、行オブジェクトを共有しない
// - 存在しないユーザーは null
const fs = require('fs');
const path = require('path');
const UserRepository = require('../../src/db/json/UserRepository');
const { getAuthUser, _resetAuthUserCache } = require('../../src/api/utils/auth-user-lookup');

const USERS_FILE = path.resolve(__dirname, '../../src/api/utils/../../data/users.json');
// createJsonRepository と同じパス解決（src/db/json/../../../data）
const REPO_USERS_FILE = path.resolve(__dirname, '../../src/db/json/../../../data/users.json');

describe('auth-user-lookup', () => {
  let original;
  beforeAll(() => {
    original = fs.existsSync(REPO_USERS_FILE) ? fs.readFileSync(REPO_USERS_FILE, 'utf-8') : null;
  });
  afterAll(() => {
    if (original !== null) fs.writeFileSync(REPO_USERS_FILE, original);
    _resetAuthUserCache();
  });
  beforeEach(() => _resetAuthUserCache());

  function addUser(id, fields = {}) {
    const rows = UserRepository.getAll();
    rows.push({ id, email: `${id}@example.com`, status: 'active', ...fields });
    fs.writeFileSync(REPO_USERS_FILE, JSON.stringify(rows, null, 2));
  }

  test('存在するユーザーの認証フィールドを返す', () => {
    addUser('u-auth-1', { status: 'active', passwordChangedAt: '2025-01-01T00:00:00Z' });
    const rec = getAuthUser('u-auth-1');
    expect(rec).not.toBeNull();
    expect(rec.status).toBe('active');
    expect(rec.passwordChangedAt).toBe('2025-01-01T00:00:00Z');
  });

  test('存在しないユーザーは null', () => {
    expect(getAuthUser('u-nonexistent')).toBeNull();
  });

  test('ファイル未変更なら再パースしない（stat ゲート）', () => {
    addUser('u-auth-2');
    getAuthUser('u-auth-2');
    const spy = jest.spyOn(UserRepository, 'getAll');
    try {
      getAuthUser('u-auth-2');
      getAuthUser('u-nonexistent-2');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('ファイル変更を検知して新規ユーザーを即座に返す', () => {
    getAuthUser('u-auth-3'); // 初回でキャッシュ構築
    addUser('u-auth-3', { status: 'deactivated' });
    const rec = getAuthUser('u-auth-3');
    expect(rec).not.toBeNull();
    expect(rec.status).toBe('deactivated');
  });

  test('返却レコードの変更が後続ルックアップへ漏洩しない', () => {
    addUser('u-auth-4', { status: 'active' });
    const rec = getAuthUser('u-auth-4');
    rec.status = 'deactivated'; // 呼び出し側のミューテーション
    const again = getAuthUser('u-auth-4');
    expect(again.status).toBe('active'); // 共有行ではないので影響しない
  });
});
