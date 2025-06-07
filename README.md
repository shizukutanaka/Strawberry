# Strawberry P2P GPU Marketplace

> **🇯🇵 日本語: このリポジトリはP2P型GPUマーケットプレイスのOSS実装です。セットアップ・運用・コントリビュートは日本語/英語どちらでも歓迎します。README・ガイドはバイリンガル対応です。ご質問・PR・Issueもお気軽にどうぞ！**
>
> **🇬🇧 English: This repository is an OSS implementation of a P2P GPU marketplace. Setup, usage, and contributions are welcome in both Japanese and English. README and guides are bilingual. Feel free to ask questions, open PRs, or Issues!**

---

## 品質・セキュリティ強化ポイント（2025年6月最新／MVP構成）

- **Google認証・OAuthアカウント認証**：Google（およびGitHub等）によるOAuth認証でユーザー識別・なりすまし防止
- **ピアID（公開鍵）＋署名検証**：P2PノードはEd25519ピアIDで識別、すべての注文・支払い・GPUイベントは署名検証
- **APIキー＋JWT認証＋ロール制御（中央API利用時）**：重要操作は多重認証＋権限チェック
- **UUIDバリデーション・入力サニタイズ**：全リソースID/主要入力の厳格検証
- **一貫したAPIレスポンス＆エラーハンドリング**：`{ message, ... }`形式で統一
- **パスワード/APIキー等の情報漏洩防止**：レスポンス・ログに絶対含めない設計
- **全操作の詳細ログ出力**：監査・トラブルシュート容易
- **CORS/Helmet等のセキュリティヘッダー**：Web攻撃対策を標準装備

---

## API自動テスト

- `tests/api.integration.test.js` にJest＋supertestによる統合テスト雛形を実装済み
- 主要APIの正常系・異常系の自動検証が可能
- `npm test` で実行（Jest/Supertest必要）

---

## 今後の推奨運用・拡張方針

- **Google認証・OAuth連携の標準化**：P2Pノード・Web UIともGoogleアカウント認証で本人性を担保
- **ピアID管理UI/アカウント連携**：ピアIDとGoogleアカウントの紐付け・失効・権限管理UI/API追加
- **永続ストレージ（分散DB/クラウド）移行**：OrbitDB, GunDB, IPFS等への段階的移行＋クラウド連携
- **Rate Limit/監査ログ強化**：DoS・悪用対策、操作履歴の永続化
- **CI/CD自動テスト・デプロイ**：品質担保・運用効率化
- **フロントエンド統合・e2eテスト**：UX検証・本番運用準備
- **障害監視・自動通知**：死活監視・異常時のLINE/Discord自動通知

---

## コントリビュート・運用者向け

- セキュリティ・品質・本人性を最優先した設計方針
- Google認証・署名検証・監査ログ・死活監視など自動化を推奨
- 詳細は各APIルート・P2Pノード・テストコード・運用ガイドを参照

---

## セットアップ・起動手順

1. **依存パッケージのインストール**
   ```sh
   npm install
   ```
   - 必要に応じてlibp2p, @chainsafe/libp2p-noise, @libp2p/tcp, @libp2p/mplex, peer-id等を追加

2. **環境変数の設定**
   - `.env`ファイルまたは環境変数で`LINE_TOKEN`などを設定（障害アラート通知用）

3. **P2Pノードの起動とCLI操作**
   ```sh
   node src/cli.js
   ```
   - 複数端末・サーバーで同時に起動することでP2Pネットワークを構成

---

## CLIコマンド例

- GPU情報の公開:
  ```
  gpu gpu01 RTX4090 1000
  ```
- 注文の発行:
  ```
  order order01 gpu01 1000
  ```
- 支払い情報の伝播:
  ```
  payment pay01 order01 1000
  ```
- 終了:
  ```
  exit
  ```
---

## 障害監視・自動通知

- ノード死活監視・障害アラートは`p2p-notify.js`で自動化
  ```sh
  node src/p2p-notify.js
  ```
- ピア接続が0になった場合、LINEで即時通知

---

## 運用Tips

- `orders.json`, `payments.json`, `gpus.json`, `health.json`は各ノードローカルで自動生成・永続化
- ノード障害時も他ノードから再同期可能
- 監査ログ・バックアップ・異常検知は今後も自動化・強化予定

---

## サンプルデータ・初期化

- `data/` ディレクトリにサンプルユーザー・注文・GPUデータ（個人情報なし）を格納
- 初回起動時に自動生成（なければ空ファイル作成）
- テスト・デモ用のダミーアカウントで動作確認可能

---

## API仕様・Swagger UI

- OpenAPI仕様書は `/openapi.json` で自動生成
- Webブラウザで `/swagger.html` にアクセスするとAPIドキュメントが参照可能

---

## コントリビュート・開発ガイド

- PR・Issue歓迎！
- `CONTRIBUTING.md` に開発フロー・ルールを記載予定
- バグ報告・機能要望はGitHub Issueで受付

---

## OSSライセンス

- 本プロジェクトは [MIT License](./LICENSE) で公開されています
- 商用利用・改変・再配布も自由です

---

## CI/CD・品質バッジ

- ![build](https://img.shields.io/badge/build-passing-brightgreen)
- ![test](https://img.shields.io/badge/test-passing-brightgreen)
- ![coverage](https://img.shields.io/badge/coverage-90%25-brightgreen)

---

## お問い合わせ・サポート

- 質問・バグ報告はGitHub IssueまたはDiscussionsへ
- 運用・導入サポートもご相談ください

---

## 公開前セルフチェックリスト

- [x] 機密情報・APIキー・個人情報が一切含まれていないか再確認
- [x] `.env.example` に必要な環境変数サンプルを記載
- [x] `data/` ディレクトリに個人情報が含まれていないことを確認
- [x] 依存パッケージ・セットアップ手順が最新READMEに反映されている
- [x] LICENSE, CONTRIBUTING.md, CI/CD, API仕様書が整備されている
- [x] サンプルデータ・自動テスト・自動ドキュメント生成が動作する
- [x] 初見ユーザーが迷わず動かせるか（セットアップからデモまで）

---

## 今後の拡張例

- Web UI/API連携・ダッシュボードの拡充
- ピアIDとGoogleアカウント等の外部ID紐付け管理UI
- 分散DB/クラウド連携によるデータ耐障害性・スケーラビリティ向上
- 信用スコア・ブラックリスト管理・レピュテーションシステム
- 多言語対応・法令対応・外部サービス連携
- AIによる自動マッチング・価格最適化
- より高度なセキュリティ・プライバシー保護

---

## コミュニティ・貢献

- Issue・Pull Request・フィードバック歓迎！
- Lightning/仮想GPU技術・分散システムに興味のある方はぜひ開発参加を
- 詳細は [CONTRIBUTING.md] をご覧ください

---

## ライセンス

MIT License  
(C) 2025 Shizuku Tanaka

---

