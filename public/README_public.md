# public/ 静的ファイル運用・自動化テンプレート

## 1. キャッシュ制御・バージョニング
- 静的ファイルはビルド時にハッシュ付きファイル名（例: main.[hash].js）で出力推奨
- サーバ/ CDNで `Cache-Control: public, max-age=31536000, immutable` を推奨

## 2. 画像圧縮・不要ファイル除外
- 画像は `npm run optimize-images` で自動圧縮（imagemin等利用）
- 不要ファイルは `.npmignore` やビルドスクリプトで除外

## 3. セキュリティヘッダー・CSP
- express利用時: helmetでCSP, X-Content-Type-Options等を付与

## 4. アクセスログ・監査証跡
- morganで静的ファイルアクセスもログ化、Winston等でファイル保存

## 5. 多言語対応
- index.html等でi18n.js/各言語ディレクトリで多言語化

## 6. CDN連携
- Cloudflare, AWS CloudFront等のCDN設定例を記載
- キャッシュパージはCI/CDからAPI連携で自動実行

## 7. 静的ファイル自動テスト・バリデーション
- jest/cypressでリンク切れ・ファイル存在・画像最適化のテスト追加

## 8. 公開範囲・権限管理
- .htaccessやサーバ設定でアクセス制御

## 9. 自動デプロイ・CI/CD連携
- GitHub Actions例:
```yaml
name: Deploy Public
on:
  push:
    paths:
      - 'public/**'
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to Server/CDN
        run: ./scripts/deploy_public.sh
```

## 10. 運用手順・FAQ
- 本ファイルを随時更新し、現場運用・改善のナレッジ基盤とする
