// tests/db/user-repository-audit-redact.test.js — db-access.log 監査記録の
// 機密フィールドマスク契約を固定するテスト（弱所#17）。
// getByEmail/getByApiKey は lookup 値を監査 detail へ生値で渡していたため、
// email/資格情報が logs/db-access.log に平文で残っていた。
const fs = require('fs');
const path = require('path');
const UserRepository = require('../../src/db/json/UserRepository');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../logs/db-access.log');

// 対象 action の最終監査行を読む — db-access.log は全リポジトリ・全 jest
// ワーカーが共有するため、ファイル末尾を取ると他スイートの行に競合する
// （CI で getAll 行を読んで失敗した実績あり）。action で絞って自分行を取る。
// 機密値はマスクされるので action 粒度の最終行で十分（他 suite の行でも
// 「マスクされている」ことは変わらない）。マスクされない値（username）の
// 検証には marker を含む行を直接探す findAuditLine を使う。
function lastAuditLine(action) {
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trimEnd().split('\n')
    .filter((l) => l.includes(`"action":"${action}"`));
  return lines[lines.length - 1];
}

// marker（生値）を含む action 行を探す — マスク「されない」ことを検証する
// 場合に行を一意に特定するために使う。
function findAuditLine(action, marker) {
  return fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n')
    .find((l) => l.includes(`"action":"${action}"`) && l.includes(marker));
}

describe('db-access.log 監査記録の機密フィールドマスク', () => {
  test('getByEmail の参照値 email がマスクされる', () => {
    const sentinel = `probe-redact-${Date.now()}@example.com`;
    UserRepository.getByEmail(sentinel);
    const line = lastAuditLine('getByEmail');
    expect(line).not.toContain(sentinel);
    expect(line).toContain('[redacted]');
  });

  test('getByApiKey の参照値 apiKey（資格情報）がマスクされる', () => {
    const sentinel = `sk-probe-redact-${Date.now()}`;
    UserRepository.getByApiKey(sentinel);
    const line = lastAuditLine('getByApiKey');
    expect(line).not.toContain(sentinel);
    expect(line).toContain('[redacted]');
  });

  test('getByUsername の参照値は監査目的のため保持される', () => {
    const sentinel = `probe-keep-${Date.now()}`;
    UserRepository.getByUsername(sentinel);
    // 生値を含む自分行を一意に特定（共有ログの並行書き込みに対して安定）
    const line = findAuditLine('getByUsername', sentinel);
    expect(line).toBeTruthy();
  });
});
