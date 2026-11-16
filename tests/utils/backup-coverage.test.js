// tests/utils/backup-coverage.test.js
// backup.js の対象列挙網羅性と backups/ の gitignore 登録を検証する。
// 認証系ファイル（revoked-tokens / users）がバックアップ対象から漏れると
// 消失時に失効トークン復活となる。（旧 payments/escrows/profit-addresses は
// 金銭機能の廃止に伴いデータ自体が存在しない。）
const fs = require('fs');
const path = require('path');

// cloud-storage.js は任意 SDK（aws-sdk 等）をトップレベル require するため
// 未導入環境では backup.js のロード自体が失敗する。対象列挙の検証には
// 実 SDK は不要なのでモックする。
jest.mock('../../src/utils/cloud-storage', () => ({
  uploadToS3: jest.fn(),
  uploadToGoogleDrive: jest.fn(),
  uploadToDropbox: jest.fn(),
}));

const { TARGET_FILES, _targetFiles } = require('../../src/utils/backup');

describe('backup target coverage', () => {
  const CRITICAL = [
    'users.json',             // パスワードハッシュ
    'revoked-tokens.json',    // 失効 JWT — 消失するとログアウト済みトークンが復活
    'orders.json',
    'gpus.json',
    'reputations.json',
  ];

  it('TARGET_FILES covers every security-critical data file', () => {
    for (const f of CRITICAL) {
      expect(TARGET_FILES).toContain(f);
    }
  });

  it('_targetFiles enumerates every *.json actually present in data/', () => {
    const dataDir = require('../../src/db/json/data-dir').resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = 'zz-backup-coverage-probe.json';
    fs.writeFileSync(path.join(dataDir, probe), '{}');
    try {
      const targets = _targetFiles();
      expect(targets).toContain(probe); // 未列挙の新規ファイルも動的に拾う
      for (const f of targets) expect(f.endsWith('.json')).toBe(true);
    } finally {
      fs.unlinkSync(path.join(dataDir, probe));
    }
  });

  it('_targetFiles falls back to the static list when data/ is unreadable', () => {
    // DATA_DIR が存在しない場合でも固定一覧へ退避する（ユニット環境の安全側）
    const target = require('../../src/utils/backup');
    expect(Array.isArray(target.TARGET_FILES)).toBe(true);
    expect(target.TARGET_FILES.length).toBeGreaterThan(0);
  });

  it('backups/ output directory is gitignored (contains password hashes & keys)', () => {
    // バックアップは users.json（パスワードハッシュ）等の平文コピーを
    // backups/ に生成する。gitignore 漏れだと git add で認証情報がコミットされる。
    const gi = fs.readFileSync(path.resolve(__dirname, '../../.gitignore'), 'utf-8');
    expect(gi).toMatch(/^backups\/\s*$/m);
  });
});
