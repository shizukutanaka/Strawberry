# Strawberry FAQ・運用ナレッジ集

---

## CI/CD・自動化
- **Q: CI/CDが失敗した場合は？**
  - A: GitHub Actionsのログとk8sイベントを確認し、再実行で解決しない場合は運用担当に連絡してください。
- **Q: 静的ファイルの自動デプロイ方法は？**
  - A: public/配下の変更はGitHub Actionsで自動デプロイされます。手動デプロイは`scripts/deploy_public.sh`を利用。

## scripts/ 運用
- **Q: スクリプトに共通設定値を追加したい**
  - A: scripts/config.jsに追記し、各スクリプトでrequireしてください。
- **Q: 多言語対応メッセージの追加方法は？**
  - A: scripts/locales/ja/translation.json, en/translation.jsonに追記し、i18nextで利用できます。

## public/ 運用
- **Q: 画像圧縮・バージョニングはどうやる？**
  - A: `npm run optimize-images`で画像自動圧縮、ビルド時にハッシュ付きファイル名で出力推奨。
- **Q: セキュリティヘッダーの設定方法は？**
  - A: express/helmetでCSP等を付与。

## docs/ 運用
- **Q: ドキュメントの目次自動生成方法は？**
  - A: `npx markdown-toc -i ファイル名.md`で目次を自動挿入。
- **Q: ナレッジ・FAQの追加方法は？**
  - A: docs/faq.mdに追記し、現場で共有。

## 障害対応・監視
- **Q: ノード障害時の一次対応は？**
  - A: 監視アラートを確認し、Pod再起動やスケール調整を行い、復旧後は #incident-report へ報告。
- **Q: 障害訓練・復旧履歴はどこで確認できる？**
  - A: docs/operations.mdやダッシュボードで確認可能。

---

現場からの新たな質問・運用ノウハウは随時このファイルに追記し、ナレッジロスゼロを目指しましょう。
