// コンプライアンス・監査証跡ユーティリティの自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');
const { recordComplianceEvent, checkEncryptionPolicy } = require('../../src/security/compliance');

const AUDIT_LOG_PATH = path.join(__dirname, '../../logs/compliance-audit.log');

describe('compliance', () => {
  beforeEach(() => {
    if (fs.existsSync(AUDIT_LOG_PATH)) fs.unlinkSync(AUDIT_LOG_PATH);
  });

  it('recordComplianceEventで監査証跡が記録される', () => {
    recordComplianceEvent('test_event', { foo: 1 });
    const content = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8');
    expect(content).toMatch(/test_event/);
  });

  it('checkEncryptionPolicy: 鍵長不足で例外', () => {
    process.env.ENCRYPTION_KEY = 'shortkey';
    expect(() => checkEncryptionPolicy()).toThrow();
  });

  it('checkEncryptionPolicy: 鍵長32byte以上でOK', () => {
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
    expect(() => checkEncryptionPolicy()).not.toThrow();
  });
});
