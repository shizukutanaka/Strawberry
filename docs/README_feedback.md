# フィードバックBot運用ガイド

## 概要
現場の声・改善案・運用課題を即時吸い上げ、docs/feedback-log.json に自動蓄積します。

## 使い方
- CLIから：
  ```sh
  node scripts/feedback-bot.js <ユーザー名> <フィードバック内容>
  ```
- 例：
  ```sh
  node scripts/feedback-bot.js yamada "APIレスポンス遅延あり。キャッシュ改善希望"
  ```
- 送信内容は `docs/feedback-log.json` に追記されます

## 応用
- GoogleフォームやSlack連携Botからも同様のJSON構造で追記可能
- 週次で自動集計・KPIレポート化も容易

## 運用Tips
- 吸い上げたフィードバックは定期的にdocs/faq.mdやimprovement_checklist*.mdに反映
- 属人化ゼロ・現場ナレッジロスゼロを目指す

---

feedback-bot.js/feedback-log.jsonの運用により、現場の声をリアルタイムでプロジェクト改善サイクルに組み込めます。
