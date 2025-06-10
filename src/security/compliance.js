// コンプライアンス・法令遵守・監査証跡ユーティリティ
const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = path.resolve(__dirname, '../../logs/compliance-audit.log');

function recordComplianceEvent(event, detail) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    const entry = { timestamp: new Date().toISOString(), event, detail };
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) {/* ログ失敗時はサイレント */}
}

// 例: 暗号化方式・鍵長・KMS連携設定チェック
function checkEncryptionPolicy() {
  // 実装例: 鍵長・方式・KMS設定を検証し、要件違反なら例外
  const key = process.env.ENCRYPTION_KEY || '';
  if (key.length < 32) {
    recordComplianceEvent('encryption_policy_violation', { reason: 'key too short', keyLength: key.length });
    throw new Error('暗号鍵長が短すぎます（32byte以上必須）');
  }
  // 他のポリシーチェックもここに追加可能
  return true;
}

module.exports = { recordComplianceEvent, checkEncryptionPolicy };
