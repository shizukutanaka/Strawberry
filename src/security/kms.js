// KMS（Key Management Service）連携ユーティリティ雛形
// 例: AWS KMS, GCP KMS, Azure KeyVault等の連携を抽象化

class KMSProvider {
  constructor() {
    // 実際のKMSクライアント設定（APIキー等）をここで初期化
  }

  // 鍵の取得
  // Returning a hardcoded constant would silently allow callers to encrypt with a
  // well-known value — trivially decryptable by any attacker. Fail loudly instead.
  async getKey(keyId) {
    throw new Error(`KMS not configured: cannot retrieve key "${keyId}". Implement a real KMS backend.`);
  }

  // 鍵の生成
  async createKey(params) {
    throw new Error('KMS not configured: cannot create key. Implement a real KMS backend.');
  }

  // 鍵のローテーション
  async rotateKey(keyId) {
    throw new Error(`KMS not configured: cannot rotate key "${keyId}". Implement a real KMS backend.`);
  }
}

module.exports = { KMSProvider };
