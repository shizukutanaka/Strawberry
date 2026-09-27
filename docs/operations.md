# Strawberry 運用手順・障害対応フロー

> 本ドキュメントは main のコード実態に同期済み（2026-09）。記載のない外部サービス
> （Grafana / Loki / PagerDuty / Chaos Mesh / 本番デプロイパイプライン）は
> 本リポジトリには存在しません。過去版にあったそれらの記述は構想メモでした。

---

## デプロイ手順（実態）

1. `main` ブランチへ push / PR マージ
2. GitHub Actions が自動実行:
   - `ci.yml` (build-test): `npm ci` → `npm run build` → `npm test`。main への
     push 時のみ、リポジトリ secrets `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID`
     が設定されていれば Netlify へ `build/` をデプロイ（未設定ならスキップ）。
   - `ci-cd.yml` (build-test-deploy): `npm ci` → `npm run build` → `npm test`。
     `Deploy` ステップは `echo` スタブ — 本番デプロイの自動化は未実装。
   - `test-coverage-check.yml`: カバレッジ閾値チェック。
   - `api-openapi-autogen.yml`: `openapi.json` 再生成（対象パス変更時）。
   - `optimize-images.yml`: `public/` 画像の最適化 PR 作成。
3. デプロイ完了通知: `ci.yml` の Slack/LINE 通知ステップ（secrets 設定時のみ）。
   ※ LINE Notify は 2025-03-31 にサービス終了済み — 新設する場合は
   LINE Messaging API または Slack Incoming Webhook を利用のこと。

## 監視・障害対応（実態）

- **死活監視**: `GET /health`（静的 ok + uptime）、`GET /ready`（データ層の疎通を検証）。
  LB / k8s probe はこの2エンドポイントを参照する。
- **メトリクス**: `GET /metrics`（Prometheus テキスト形式）。
  本番では `METRICS_AUTH_TOKEN` 必須（未設定では 503 で fail-closed、公開されない）。
  Bearer 照合で保護される KPI（Lightning チャネル容量・支払い失敗・キャッシュ等）。
- **サービス監視**: `src/core/service-monitor.js` が LightningService /
  P2PNetwork / VirtualGPUManager を定期ヘルスチェックし、不健全なら
  `initialize()` で自動再起動 + 外部通知。
- **外部通知**（環境変数ゲート — 未設定なら無効）:
  - `SLACK_WEBHOOK_URL` → `scripts/slack-notify.js` 経由で Slack 投稿
  - `SENTRY_DSN` → `scripts/sentry-notify.js` 経由で Sentry（要 `@sentry/node`）
  - メール: SendGrid / Mailgun / SMTP（`notifier` 経由。`EMAIL_*` / `SENDGRID_*` 等）
- **監査ログ**: `src/utils/audit-log.js` — ハッシュ連鎖の append-only ログを
  `logs/` 配下へ記録（改ざん検知用）。ログ本体は winston のサイズローテーション付き。
- **定期ジョブ（プロセス内）**: invoice-poller（入金確認ポーリング）、
  order-expiry（期限切れ注文スイープ）、sla-tracker（稼働率/違反記録）、
  service-monitor 上記。
- **バックアップ / 復旧**: `src/utils/backup.js` — `backupAll`（対象の
  `data/*.json` を `backups/` へ世代管理コピー + 任意でクラウド送信）と
  `restoreFromLatestBackup`（破損時に最新バックアップから復元。
  `p2p-sync.js` が使用）を提供。`backupAll` の定期実行はコード上未配線。
  手動/cron で呼ぶ場合は任意クラウド SDK（`@aws-sdk/client-s3` 等）の導入が
  必要 — 現状 `backup.js` はこれらをトップレベル require するため、未導入環境では
  `require` 自体が MODULE_NOT_FOUND で失敗する点に注意。

## 障害時の初動（推奨手順）

1. `GET /ready` でデータ層疎通を確認、`GET /health` でプロセス稼働を確認
2. `logs/` の `error.log` / `combined.log` と監査ログ（`logs/audit*`）を参照
3. `GET /metrics`（`METRICS_AUTH_TOKEN` で Bearer 認証）で失敗カウンタを確認
4. 外部サービス起因なら各サービスの status を確認（LND / 為替 API / SMTP 等）
5. `data/*.json` 破損時は `backups/` から `restoreFromLatestBackup` で復旧

## FAQ・トラブルシュート

- よくある質問・障害対応例は `docs/faq.md` を参照

---

現場の運用手順・障害対応フローは本ドキュメントに随時追記し、ナレッジロスゼロを目指しましょう。
