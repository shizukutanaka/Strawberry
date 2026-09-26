# Strawberry FAQ・運用ナレッジ集

---

## CI/CD・自動化
- **Q: CI/CDが失敗した場合は？**
  - A: GitHub Actions のログを確認し、再実行で解決しない場合は運用担当に連絡してください。主なワークフローは `ci.yml`（build-test: `npm ci`→`npm test`）、`test-coverage-check.yml`（カバレッジ閾値 70）、`optimize-images.yml`（package.json 変更時）、`ci-cd.yml`（main push で lint/test/アセット version。Deploy ステップは現状スタブ）です。
- **Q: 静的ファイルのデプロイ方法は？**
  - A: 自動デプロイは未実装です（`ci-cd.yml` の Deploy ステップは `echo` のプレースホルダ）。`public/` 配下の変更は現在のところ手動デプロイが必要です。

## scripts/ 運用
- **Q: スクリプトに共通設定値を追加したい**
  - A: `scripts/config.js` に追記し、各スクリプトで require してください（API_ENDPOINT・LANG 等）。
- **Q: 多言語対応メッセージの追加方法は？**
  - A: `scripts/locales/ja/translation.json`、`scripts/locales/en/translation.json` に追記すると i18next 経由で利用できます。
- **Q: ops スクリプトが `Cannot find module` で落ちる**
  - A: 各スクリプトが必要とする外部パッケージ（`googleapis`・`@notionhq/client`・`@slack/web-api` 等）は `optionalDependencies` に集約されています。`npm ci` を実行してください。
- **Q: ops スクリプトの必須 env が分からない**
  - A: `docs/operations.md` のスクリプト一覧表に必須 env をまとめています（必須 env 未設定のスクリプトは手順メッセージ付きで終了します）。

## public/ 運用
- **Q: 画像圧縮・バージョニングはどうやる？**
  - A: `npm run optimize-images` で public/assets 内画像を圧縮、`npm run version-assets` → `npm run update-references` で fingerprint 付きファイル名＋HTML/CSS/JS 参照の書き換えを行います。
- **Q: セキュリティヘッダーの設定方法は？**
  - A: express の helmet で CSP/COOP/CORP/Permissions-Policy 等を付与しています（`src/api/server.js`）。

## docs/ 運用
- **Q: ドキュメントの目次自動生成方法は？**
  - A: `npx markdown-toc -i ファイル名.md` で目次を自動挿入できます（markdown-toc は npx 実行・依存未収録）。
- **Q: ナレッジ・FAQの追加方法は？**
  - A: `docs/faq.md` に追記し、現場で共有してください。

## 障害対応・監視
- **Q: サービス障害時の一次対応は？**
  - A: `GET /health`（死活）と `GET /metrics`（`METRICS_AUTH_TOKEN` で Bearer 保護）を確認し、`logs/` のログ（`access-audit.log`・`db-access.log`・`gpu-events.log` 等）を点検してください。`service-monitor`（既定 10s 周期）が Lightning/vGPU 等のオプショナルサービスの健全性を監視します。
- **Q: 期限切れ注文の手動処理は？**
  - A: `POST /api/v1/admin/expire-orders`（admin JWT、`{types: ['pending','matched','disputed','active']}` 部分実行可）で滞留注文のスイープを手動実行できます。

---

現場からの新たな質問・運用ノウハウは随時このファイルに追記し、ナレッジロスゼロを目指しましょう。
