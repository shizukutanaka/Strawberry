// tests/utils/backup.test.js
// cloud-storage.js の遅延 require 化と backup.js のローカル世代バックアップ/リストアを検証。
// 背景: cloud-storage.js がトップレベルで googleapis/dropbox（任意依存・未宣言）を
// require していたため、googleapis 未インストール環境では require('backup') 自体が
// MODULE_NOT_FOUND で落ち、ローカル世代バックアップすら動かなかった。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const BACKUP_DIR = path.join(ROOT, 'backups');

const backup = require('../../src/utils/backup');
const cloudStorage = require('../../src/utils/cloud-storage');

describe('cloud-storage の遅延 require', () => {
  test('任意 SDK 未導入でもモジュール読込自体は成功する', () => {
    expect(typeof cloudStorage.uploadToS3).toBe('function');
    expect(typeof cloudStorage.uploadToGoogleDrive).toBe('function');
    expect(typeof cloudStorage.uploadToDropbox).toBe('function');
  });

  test('未導入 SDK の呼出は MODULE_NOT_FOUND ではなく導入手順付きエラーになる', async () => {
    // googleapis / dropbox は package.json 未宣言（任意依存）のためこの環境では解決不可。
    // aws-sdk は optionalDependencies 宣言済みのため存在する場合は要求失敗になり得る —
    // その場合でも「require エラーでなく設定系エラー」を主張したいので緩めに検証。
    // googleapis は optionalDependencies 宣言済みのため、導入済みなら SDK 要求エラーでなく
    // 読み込めないローカルファイルの ENOENT で reject される（未処理 stream error で落ちない）ことを検証。
    let hasGoogleApis = true;
    try { require.resolve('googleapis'); } catch (_) { hasGoogleApis = false; }
    await expect(cloudStorage.uploadToGoogleDrive('/tmp/nope', 'x', null))
      .rejects.toThrow(hasGoogleApis ? /ENOENT/ : /googleapis/);
    await expect(cloudStorage.uploadToDropbox('/tmp/nope', '/x', 'tok'))
      .rejects.toThrow(/dropbox/);
  });
});

describe('backup.js: ローカル世代バックアップ', () => {
  let tmpFile;
  const createdBackups = [];

  beforeAll(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-backup-')), 'orders.json');
  });

  afterAll(() => {
    // テストが backups/ に残した世代ファイルを掃除する（リポジトリを汚さない）
    for (const f of createdBackups) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
    }
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  test('世代付きバックアップが作成され、最新世代からリストアできる', () => {
    fs.writeFileSync(tmpFile, JSON.stringify([{ id: 'v1' }]));
    backup.backupLocalWithGeneration(tmpFile);

    const base = path.basename(tmpFile);
    const baks = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(base + '.bak-'));
    expect(baks.length).toBe(1);
    createdBackups.push(...baks);

    fs.writeFileSync(tmpFile, 'not json{'); // 破損を模倣
    expect(backup.restoreFromLatestBackup(tmpFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(tmpFile))).toEqual([{ id: 'v1' }]);
  });

  test('存在しないファイルのバックアップは no-op', () => {
    const missing = path.join(path.dirname(tmpFile), 'not-here.json');
    expect(() => backup.backupLocalWithGeneration(missing)).not.toThrow();
  });

  test('バックアップが存在しない場合は false を返す', () => {
    const nope = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nobak-')), 'nonexistent.json');
    expect(backup.restoreFromLatestBackup(nope)).toBe(false);
    fs.rmSync(path.dirname(nope), { recursive: true, force: true });
  });
});
