// src/api/utils/user-dispute-count.js の検証。
// - 係争裁定カウンタ（vindicated/denied）の +1 加算
// - 同一ユーザーの並行加算が直列化され lost-update しない
// - ユーザー不在時は null を返し書き込まない
const fs = require('fs');
const path = require('path');
const UserRepository = require('../../src/db/json/UserRepository');
const { incrementDisputeCount } = require('../../src/api/utils/user-dispute-count');
const { resolveDataDir } = require('../../src/db/json/data-dir');

const REPO_USERS_FILE = path.join(resolveDataDir(), 'users.json');

describe('incrementDisputeCount', () => {
  let original;
  beforeAll(() => {
    original = fs.existsSync(REPO_USERS_FILE) ? fs.readFileSync(REPO_USERS_FILE, 'utf-8') : null;
    fs.writeFileSync(REPO_USERS_FILE, '[]');
  });
  afterAll(() => {
    if (original !== null) fs.writeFileSync(REPO_USERS_FILE, original);
  });

  function seedUser(id, fields = {}) {
    const rows = UserRepository.getAll();
    rows.push({ id, email: `${id}@example.com`, status: 'active', ...fields });
    fs.writeFileSync(REPO_USERS_FILE, JSON.stringify(rows, null, 2));
  }

  test('vindicatedDisputeCount を +1 する', async () => {
    seedUser('u-v');
    const next = await incrementDisputeCount('u-v', 'vindicatedDisputeCount');
    expect(next).toBe(1);
    expect(UserRepository.getById('u-v').vindicatedDisputeCount).toBe(1);
  });

  test('deniedDisputeCount を +1 し既存値から積み上げる', async () => {
    seedUser('u-d', { deniedDisputeCount: 2 });
    const next = await incrementDisputeCount('u-d', 'deniedDisputeCount');
    expect(next).toBe(3);
  });

  test('同一ユーザーの並行加算は全て反映される（lost-update しない）', async () => {
    seedUser('u-c');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => incrementDisputeCount('u-c', 'vindicatedDisputeCount'))
    );
    // 直列化されていれば加算は 1..5 を全て通る（重複値は生じない）
    expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(UserRepository.getById('u-c').vindicatedDisputeCount).toBe(5);
  });

  test('存在しないユーザーは null を返し例外を投げない', async () => {
    await expect(incrementDisputeCount('no-such', 'vindicatedDisputeCount')).resolves.toBeNull();
  });

  test('他フィールドを壊さない', async () => {
    seedUser('u-p', { email: 'keep@example.com', vindicatedDisputeCount: 7 });
    await incrementDisputeCount('u-p', 'deniedDisputeCount');
    const u = UserRepository.getById('u-p');
    expect(u.email).toBe('keep@example.com');
    expect(u.vindicatedDisputeCount).toBe(7);
    expect(u.deniedDisputeCount).toBe(1);
  });
});
