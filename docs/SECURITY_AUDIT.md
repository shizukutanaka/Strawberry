# セキュリティ監査・運用ガイド

## 1. 監査ログ
- すべてのAPIリクエスト・レスポンスは機密情報をマスキングして監査ログに記録
- 監査ログは改ざん検知のためハッシュチェーン化（実装済み）

## 2. 利益アドレス分散
- 運営利益は複数アドレスに分散送金し、単一アドレス漏洩時のリスクを最小化
- アドレスは`data/profit-addresses.json`で管理、ラウンドロビン/ランダムで自動選択

## 3. Lightning API連携
- サーバー側で秘密鍵を保持せず、APIキーのみで外部決済サービスを利用
- OpenNode/LNbits/BTCPay等のAPI制限・2FA・監査ログを活用

## 4. .env・秘密情報管理
- `.env`や`data/`は`.gitignore`済み（OSS公開時の情報漏洩防止）
- サンプル用`.env.example`のみ公開

## 5. 推奨運用
- APIキーは最小権限・短期間でローテーション
- 利益アドレスは複数登録・定期的に変更
- 監査ログ・利益分配履歴は定期的にバックアップ

---

# Security Audit & Operations Guide (English)

## 1. Audit Logging
- All API requests/responses are logged with sensitive fields masked
- Audit logs are hash-chained for tamper detection (implemented)

## 2. Profit Address Diversification
- Operator profit is distributed to multiple addresses to minimize risk of single address compromise
- Addresses are managed in `data/profit-addresses.json` and selected in round-robin/random manner

## 3. Lightning API Integration
- No private keys stored on server; only API keys for external payment providers
- Use OpenNode/LNbits/BTCPay API restrictions, 2FA, and audit logs

## 4. .env & Secret Management
- `.env` and `data/` are `.gitignore`d to prevent leaks in OSS/public repos
- Only `.env.example` is public

## 5. Operational Recommendations
- Use minimal-scope, short-lived API keys and rotate regularly
- Register multiple profit addresses and rotate periodically
- Regularly back up audit logs and profit distribution records
