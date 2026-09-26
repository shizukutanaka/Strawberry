// JSON リポジトリの破損時自動復元 + 世代バックアップのテスト
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');
const { backupLocalWithGeneration, restoreFromLatestBackup } = require('../../src/utils/backup');

const DATA_DIR = path.resolve(__dirname, '../../data');
const BACKUP_DIR = path.resolve(__dirname, '../../backups');
const TEST_FILE = 'test-autorestore-repo.json';
const TEST_PATH = path.join(DATA_DIR, TEST_FILE);

function cleanup() {
  for (const f of fs.readdirSync(DATA_DIR).filter(f => f.startsWith('test-autorestore-repo'))) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
  }
  if (fs.existsSync(BACKUP_DIR)) {
    for (const f of fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(TEST_FILE))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
  }
}

describe('backup.js + json-repo 自動復元', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('cloud-storage 未導入でも require できる（遅延ロード）', () => {
    // 既に require 済みだが、トップレベル require が残っていればこのテスト自体が起動しない
    expect(typeof backupLocalWithGeneration).toBe('function');
  });

  it('backupLocalWithGeneration が世代バックアップを作成し restoreFromLatestBackup が復元する', () => {
    fs.writeFileSync(TEST_PATH, JSON.stringify([{ id: 'r1', v: 1 }]));
    backupLocalWithGeneration(TEST_PATH);
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(TEST_FILE + '.bak-'));
    expect(backups.length).toBe(1);
    // 本番ファイルを破壊してから復元
    fs.writeFileSync(TEST_PATH, 'not-json{{{');
    expect(restoreFromLatestBackup(TEST_PATH)).toBe(true);
    expect(JSON.parse(fs.readFileSync(TEST_PATH, 'utf-8'))).toEqual([{ id: 'r1', v: 1 }]);
  });

  it('repo.load() は破損時に最新バックアップへ自動復元し、破損ファイルを退避する', () => {
    // 1) 正常データ → 世代バックアップ作成
    fs.writeFileSync(TEST_PATH, JSON.stringify([{ id: 'a', amount: 100 }]));
    backupLocalWithGeneration(TEST_PATH);
    // 2) 破損させて getAll — 自動復元されるはず
    fs.writeFileSync(TEST_PATH, '{"broken":');
    const repo = createJsonRepository(TEST_FILE);
    const rows = repo.getAll();
    expect(rows).toEqual([{ id: 'a', amount: 100 }]);
    // 破損ファイルが .corrupt- として退避されている
    const corruptAsides = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(TEST_FILE + '.corrupt-'));
    expect(corruptAsides.length).toBe(1);
    expect(fs.readFileSync(path.join(DATA_DIR, corruptAsides[0]), 'utf-8')).toBe('{"broken":');
  });

  it('バックアップが無い場合は従来通り fail-closed で throw し、破損ファイルを温存する', () => {
    fs.writeFileSync(TEST_PATH, '{{{corrupt');
    const repo = createJsonRepository(TEST_FILE);
    expect(() => repo.getAll()).toThrow(/corrupt/);
    // 破損ファイルは消えず温存される（バックアップ無しのため退避も行われない）
    expect(fs.readFileSync(TEST_PATH, 'utf-8')).toBe('{{{corrupt');
  });
});
