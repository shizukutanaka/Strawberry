// tests/db/user-repository-audit-redact.test.js — db-access.log 監査記録の
// 機密フィールドマスク契約を固定するテスト（弱所#17）。
// getByEmail/getByApiKey は lookup 値を監査 detail へ生値で渡していたため、
// email/資格情報が logs/db-access.log に平文で残っていた。
const fs = require('fs');
const path = require('path');
const UserRepository = require('../../src/db/json/UserRepository');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../logs/db-access.log');

// 直近の監査行（末尾非空行）を読む — appendRotated は同期書き込み。
function lastAuditLine() {
  const raw = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trimEnd().split('\n');
  return raw[raw.length - 1];
}

describe('db-access.log 監査記録の機密フィールドマスク', () => {
  test('getByEmail の参照値 email がマスクされる', () => {
    const sentinel = `probe-redact-${Date.now()}@example.com`;
    UserRepository.getByEmail(sentinel);
    const line = lastAuditLine();
    expect(line).not.toContain(sentinel);
    expect(line).toContain('[redacted]');
  });

  test('getByApiKey の参照値 apiKey（資格情報）がマスクされる', () => {
    const sentinel = `sk-probe-redact-${Date.now()}`;
    UserRepository.getByApiKey(sentinel);
    const line = lastAuditLine();
    expect(line).not.toContain(sentinel);
    expect(line).toContain('[redacted]');
  });

  test('getByUsername の参照値は監査目的のため保持される', () => {
    const sentinel = `probe-keep-${Date.now()}`;
    UserRepository.getByUsername(sentinel);
    const line = lastAuditLine();
    expect(line).toContain(sentinel);
  });
});
