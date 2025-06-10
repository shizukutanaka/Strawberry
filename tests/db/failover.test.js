// DB障害時の自動フェイルオーバー・リカバリユーティリティの自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');
const { DBFailoverManager } = require('../../src/db/failover');

describe('DBFailoverManager', () => {
  const primary = path.join(__dirname, 'primary.db');
  const backup = path.join(__dirname, 'backup.db');

  beforeEach(() => {
    // テスト用DBファイル作成/削除
    if (fs.existsSync(primary)) fs.unlinkSync(primary);
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    fs.writeFileSync(primary, 'dummy');
    fs.writeFileSync(backup, 'dummy');
  });

  afterEach(() => {
    if (fs.existsSync(primary)) fs.unlinkSync(primary);
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  });

  it('プライマリ利用可能ならプライマリ', () => {
    const mgr = new DBFailoverManager(primary, backup);
    expect(mgr.failoverIfNeeded()).toBe(primary);
  });

  it('プライマリ障害時はバックアップへフェイルオーバー', () => {
    fs.unlinkSync(primary); // プライマリ障害
    const mgr = new DBFailoverManager(primary, backup);
    expect(mgr.failoverIfNeeded()).toBe(backup);
  });

  it('プライマリ復旧でプライマリ復帰', () => {
    fs.unlinkSync(primary);
    const mgr = new DBFailoverManager(primary, backup);
    mgr.failoverIfNeeded();
    fs.writeFileSync(primary, 'dummy');
    expect(mgr.recoverIfPossible()).toBe(primary);
  });
});
