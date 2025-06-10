# Strawberry 運用手順・障害対応フロー

---

## デプロイ手順
1. mainブランチへpush
2. GitHub Actionsで自動ビルド・テスト・本番デプロイ
3. デプロイ状況はSlack #alerts で通知

## 監視・障害対応
- 監視はPrometheus/Grafana/Lokiで自動化
- 障害発生時はSlack/PagerDutyに自動通知
- ログ・メトリクス確認 → Pod再起動・スケール調整
- 障害レポートは #incident-report へ投稿

## 障害訓練・復旧フロー
- Chaos Mesh等で定期的に障害訓練を自動実施
- 訓練・障害対応履歴は本ドキュメントに自動追記

## FAQ・トラブルシュート
- よくある質問・障害対応例は docs/faq.md を参照

---

現場の運用手順・障害対応フローは本ドキュメントに随時追記し、ナレッジロスゼロを目指しましょう。
