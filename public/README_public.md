# public/ 静的ファイル運用ガイド

本ディレクトリは `src/api/server.js` の `express.static` で配信される SPA / 静的アセット群（index.html・css・js・swagger.html・Electron シェル）。運用の実態は以下の通り。

## 1. キャッシュ制御・バージョニング
- 静的ファイルは `express.static` の既定（ETag / Last-Modified）で配信される。ハッシュ付きファイル名へのフィンガープリント用に `npm run version-assets`（`scripts/version-assets.js` + `scripts/update-references.js`）が用意されている
- 動的 API レスポンスには `Cache-Control: no-store` を明示付与（server.js）

## 2. 画像圧縮
- `npm run optimize-images`（`scripts/optimize-images.js`、imagemin + mozjpeg / pngquant）で `public/images/` を圧縮。CI の `optimize` ジョブ（`.github/workflows/optimize-images.yml`）が `public/images/**` への push で自動実行

## 3. セキュリティヘッダー・CSP
- `src/api/middleware/security.js` で helmet ベースの CSP / X-Content-Type-Options / Permissions-Policy を付与。CSP は `script-src 'self'` 厳格方針（CDN やインラインスクリプト不可）のため、`swagger.html` も same-origin の `js/docs.js`（無依存の OpenAPI ビューア）で実装

## 4. アクセスログ・監査証跡
- `src/api/middleware/audit.js` が全 API リクエストを `logs/access-audit.log` へ記録（機微フィールドはマスク）。アプリケーションログは `src/utils/logger.js`（Winston）が `logs/` 配下へ出力

## 5. 多言語対応
- 現状 UI は日本語のみ。`i18next` は ops スクリプト（レポート生成等）側で利用

## 6. CDN 連携
- Cloudflare ゾーンのキャッシュパージは `.github/workflows/cdn-cache-purge.yml` が `public/**` への push で自動実行（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` シークレット必須）

## 7. 静的ファイルのテスト
- `tests/e2e/` の Playwright スペック（`tests/e2e/*.spec.js`）が実ブラウザで SPA 全画面（認証・マーケット・注文・管理）を検証。実行: `npm run test:e2e`（別途 `npx playwright install chromium` が必要）

## 8. 公開範囲
- `public/` 配下は認証なしで配信される。機密データは置かない（取引データ・資格情報は `data/`・`logs/` に隔離、.gitignore 済み）

## 9. デプロイ・CI/CD 連携
- `ci-cd.yml`（main push）で lint・test・build を実行。本番デプロイ自体は未配線（Deploy ステップはスタブ）— 実デプロイは別途手順を整備する

## 10. 運用手順・FAQ
- 起動・監視・障害対応の実運用リファレンスは `docs/operations.md` を参照
