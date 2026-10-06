# Strawberry 運用手順・障害対応フロー

Strawberry マーケットプレイス本体（Express API + JSON ファイルリポジトリ）と ops スクリプト群の運用リファレンス。設定値の完全な一覧は `.env.example`（機能別に整理済み、既定値はコメント明記）を参照。

> 以前の本ファイルに記載されていた「main push 時の自動デプロイ」「Prometheus/Grafana/Loki」「PagerDuty 通知」「Chaos Mesh 障害訓練」等の節は、リポジトリ内に対応する実装・ワークフロー・依存が存在しない架空の運用像だったため、コード実態に基づく内容へ置き換えた（SPECIFICATION/ARCHITECTURE 実態同期と同方針）。実際のデプロイ・監視構成が整備された段階で再追記する。

## 起動・開発

| コマンド | 用途 |
|---|---|
| `npm start` | 本番サーバ起動（`node src/api/server.js`） |
| `npm run dev` | 開発起動（nodemon 再読み込み） |
| `npm test` | 全テスト（jest --forceExit） |
| `npm run coverage` | カバレッジ付きテスト（`coverage/coverage-summary.json` を生成） |
| `npm run lint` | 全 .js ファイルの `node --check` 構文検査（eslint は依存に含まれないためゼロ依存実装） |
| `npm run openapi` | `openapi.json` を実ルート走査から再生成 |
| `npm run setup` | 新規環境の一括セットアップ（`npm ci` → openapi-gen → test） |
| `npm run verify-data` | `data/*.json` の参照整合性を読み取り専用で検査（order↔payment↔escrow の不整合・資金ロック残存を検出。不整合時 exit 1） |

## 必須環境変数（最小構成）

| 変数 | 用途 | 未設定時 |
|---|---|---|
| `JWT_SECRET` | JWT 署名鍵（32文字以上） | 本番では未設定で起動失敗（fail-fast）。開発ではエフェメラル鍵（再起動で全トークン失効） |
| `JWT_REFRESH_SECRET` | refresh token 署名鍵 | 省略時 `JWT_SECRET` にフォールバック |
| `PORT` | API ポート | 既定 3000 |
| `METRICS_AUTH_TOKEN` | `/metrics` の Bearer 認証 | 未設定かつ本番 → 503（fail-closed） |

## 常駐ループ（`npm start` 内で自動起動）

| ループ | 周期 | 制御 env |
|---|---|---|
| メトリクス更新（`updateLightningMetrics`） | 10s | — |
| service-monitor（Lightning/vGPU 等のヘルスチェック） | `SERVICE_MONITOR_INTERVAL_MS`（既定 10s） | `MONITOR_TARGETS`（監視 URL 一覧） |
| invoice-poller（LN インボイス入金確認） | 15s | —（Lightning 未導入時は自動無効） |
| 注文スイープ（heartbeat SLA・pending/matched/disputed/active の期限切れ処理） | 30s（order ルートモジュール内）+ 一覧/作成時の遅延スイープ | `ORDER_PENDING_TIMEOUT_MINUTES`, `ORDER_MATCHED_TIMEOUT_MINUTES`, `ORDER_DISPUTE_TIMEOUT_DAYS`, `ORDER_ACTIVE_TIMEOUT_HOURS` |
| backup-scheduler（`data/*.json` の定期バックアップ） | `BACKUP_INTERVAL_HOURS`（時間単位） | `BACKUP_INTERVAL_HOURS`（0・未設定・不正値 = 無効） |

期限切れ注文の手動スイープ（インシデント対応用）: `POST /api/v1/admin/expire-orders`（admin のみ）。

通知チャネル（いずれも未設定なら該当経路のみスキップ）: `SLACK_WEBHOOK_URL` / `SLACK_WEBHOOK`, `LINE_TOKEN`（+ `LINE_NOTIFY_URL`）, `DISCORD_WEBHOOK`, `GENERIC_WEBHOOK`, `EMAIL_API_KEY`/`EMAIL_API_URL`/`EMAIL_TO`, `SENTRY_DSN`。

## 監視エンドポイント

- `GET /health` — 静的 `ok` + uptime。プロセス稼働確認用（LB / k8s probe 参照先）。
- `GET /ready` — データ層の疎通を検証する readiness probe。
- `GET /metrics` — Prometheus テキスト形式（Lightning チャネル容量・支払い失敗・キャッシュ・vGPU 割当状況等）。本番では `METRICS_AUTH_TOKEN` による Bearer 認証必須（未設定 → 503 fail-closed で非公開）。vGPU 系: `vgpu_instances{status}`（available/allocating/allocated 等のインスタンス数）と `vgpu_allocations_active`（active アロケーション数）— 閾値超過アラートは Prometheus 側で `vgpu_allocations_active / sum(vgpu_instances)` 等のルールとして設定する。
- 監査ログ — `src/utils/audit-log.js` がハッシュ連鎖の append-only ログを `logs/` 配下へ記録（改ざん検知用）。

## 運用スクリプト（`scripts/` → `npm run <name>`）

全スクリプト共通: 必須 env が未設定なら起動時に手順メッセージ付きで終了（exit 1）。

| スクリプト | 用途 | 必須 env |
|---|---|---|
| `prepare-data` | データディレクトリ・初期 JSON 生成 | — |
| `version-assets` / `update-references` | public/ のアセット fingerprint 付与と HTML/CSS/JS 参照書き換え | — |
| `optimize-images` | public/assets 内画像の最適化（mozjpeg/pngquant） | — |
| `gpu-failure-monitor` | GPU ノード死活監視（障害時 Slack 通知＋ログ） | `SLACK_WEBHOOK_URL`（通知時） |
| `feedback-report` / `feedback-to-checklist` / `feedback-priority` | フィードバックの集計・チェックリスト化・優先度付け | — |
| `slack-notify` / `slack-feedback-bot` / `slack-notify-notion` / `slack-notify-checklist-kpi` | Slack へレポート投稿 | `SLACK_WEBHOOK_URL` |
| `slack-notify-graph` | KPI グラフ画像を Slack アップロード | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL` |
| `progress-report` / `priority-to-sheets` | Google Sheets へ進捗・優先度転記 | `PROGRESS_SHEET_ID` + `scripts/credentials.json` と `scripts/token.json`（Google OAuth） |
| `feedback-to-sheets` | フィードバックを Sheets へ転記 | `FEEDBACK_SHEET_ID` + 同上 OAuth ファイル |
| `priority-to-notion` / `notion-progress-report` | Notion DB へ転記 | `NOTION_TOKEN`, `NOTION_DB_ID` |
| `checklist-to-issues` | チェックリストから GitHub Issue 一括作成 | `GITHUB_TOKEN`, `GITHUB_REPO`（`owner/repo`） |
| `alert-*`（`alert-high-priority`, `alert-overdue`, `alert-overdue-high`, `alert-kpi-trend`） | 期限/KPI アラートを Slack 投稿 | `SLACK_WEBHOOK_URL` |
| `kpi-trend-graph` / `checklist-kpi-report` / `assignee-progress-report` | KPI グラフ生成・担当者レポート | — |
| `sentry-notify` | Sentry エラー通知 | `SENTRY_DSN` |
| `line-notify` | LINE Notify 送信（service-monitor が利用） | `LINE_TOKEN` |

Google Sheets 系の OAuth セットアップ: `scripts/credentials.json`（GCP Console の OAuth クライアント JSON）と `scripts/token.json`（初回認可の発行トークン）を配置。詳細は `npm run <script>` 実行時のエラーメッセージに手順が出力される。

## CI・デプロイ（実態）

| ジョブ | 内容 |
|---|---|
| `build-test`（ci.yml） | `npm ci` → `npm run build` → `npm test`。main への push 時のみ、リポジトリ secrets `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` が設定されていれば Netlify へ `build/` をデプロイ（未設定ならスキップ） |
| `build-test-deploy`（ci-cd.yml） | `npm ci` → `npm run build` → `npm test`。`Deploy` ステップは `echo` スタブ — 本番デプロイの自動化は未実装 |
| `test`（test-coverage-check.yml） | カバレッジ付きテスト + `coverage-summary.json` の行カバレッジ ≥ 70 閾値チェック（src/**・tests/** 変更時） |
| `openapi-gen`（api-openapi-autogen.yml） | 対象パス変更時に `openapi.json` 再生成 |
| `optimize`（optimize-images.yml） | package.json 変更時に `npm run optimize-images` の最適化 PR 作成 |

デプロイ完了/失敗通知: `ci.yml` の LINE 失敗通知ステップ（secrets `LINE_TOKEN` 設定時のみ）。
※ LINE Notify は 2025-03-31 にサービス終了済み — 新設する場合は LINE Messaging API または Slack Incoming Webhook を利用のこと。

## データ・ログ管理

- `data/*.json` — JSON ファイルリポジトリの実データ（gitignore 済み）。破損時は fail-closed で起動/読み込みを中断するため、手動で `data/` を点検・復旧する。
- `logs/*.log` — `access-audit.log`・`db-access.log`・`gpu-events.log`・ハッシュチェーン監査ログ（`AUDIT_LOG_PATH`）等、追記型（`logs/` 直下）。ローテーション機構はなく、ディスク使用量は外部で監視・退避する（`MAX_AUDIT_LOG_MB` は監査ログの上限）。
- `backups/` — バックアップ出力先。`src/utils/backup.js` が `backupAll`（`data/*.json` を `backups/` へ世代管理コピー + 任意でクラウド送信）と `restoreFromLatestBackup`（破損時に最新バックアップから復元。`p2p-sync.js` が使用）を提供する。定期実行は `src/core/backup-scheduler.js` が `server.js` から起動し、`BACKUP_INTERVAL_HOURS` 設定時のみ有効（未設定なら無効 — 手動/cron で `backupAll` を呼ぶ運用も可能）。任意クラウド送信は対応 SDK（`@aws-sdk/client-s3` 等）の導入が必要だが、`cloud-storage.js` は遅延 require のため未導入環境でも `require('./backup')` 自体は成功し、クラウド送信の呼び出し時のみ手順付きエラーになる。

## 障害時の初動（推奨手順）

1. `GET /ready` でデータ層疎通、`GET /health` でプロセス稼働を確認
2. `logs/` の `error.log` / `combined.log` と監査ログ（`logs/audit*`）を参照
3. `GET /metrics`（`METRICS_AUTH_TOKEN` で Bearer 認証）で失敗カウンタを確認
4. 外部サービス起因なら各サービスの status を確認（LND / 為替 API / SMTP 等）
5. `data/*.json` 破損時は `backups/` から `restoreFromLatestBackup` で復旧（`p2p-sync.js` が起動時に自動試行する経路と同一）

## FAQ・トラブルシュート

よくある質問・障害対応例は `docs/faq.md` を参照。現場の運用手順・障害対応フローは本ドキュメントに随時追記する。
