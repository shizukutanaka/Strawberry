# セキュリティ監査・運用ガイド

## 1. 監査ログ
- すべてのAPIリクエスト・レスポンスは機密情報をマスキングして監査ログに記録
- 監査ログは改ざん検知のためハッシュチェーン化（実装済み）

## 2. 金銭機能の廃止（2026-11-16）
- 運営利益アドレス・Lightning API 連携を含む金銭のやり取り機能は、所有者方針により全て削除済み。
- 本システムは資金を保持・送金しないため、送金先アドレスや決済 API キーの管理は不要。

## 4. .env・秘密情報管理
- `.env`や`data/`は`.gitignore`済み（OSS公開時の情報漏洩防止）
- サンプル用`.env.example`のみ公開

## 5. 推奨運用
- APIキーは最小権限・短期間でローテーション
- 監査ログは定期的にバックアップ

---

# Security Audit & Operations Guide (English)

## 1. Audit Logging
- All API requests/responses are logged with sensitive fields masked
- Audit logs are hash-chained for tamper detection (implemented)

## 2. Money Features Removed (2026-11-16)
- All money-movement features, including profit addresses and Lightning API integration, were removed by owner decision.
- The system never holds or transfers funds, so payout addresses and payment API keys are no longer managed.

## 4. .env & Secret Management
- `.env` and `data/` are `.gitignore`d to prevent leaks in OSS/public repos
- Only `.env.example` is public

## 5. Operational Recommendations
- Use minimal-scope, short-lived API keys and rotate regularly
- Regularly back up audit logs
