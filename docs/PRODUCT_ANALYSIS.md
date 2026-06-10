# Strawberry プロダクト分析 — 長所・短所・不足機能（2026-06）

コードベース実走査に基づく評価。チェックリスト類の自己申告ではなく、実装・テストで裏取りした内容のみを記載する。

---

## 長所（Strengths）

### 1. コア取引フローが実働する
- ユーザー登録 → ログイン → GPU 閲覧 → 注文作成 → 状態遷移（pending→matched→active→completed）→ 決済記録までが API として動作し、統合テストで検証されている（`tests/api.integration.test.js` 18件）。
- 注文状態機械（`src/utils/state-checker.js`）とエスクロー状態機械（`src/payments/escrow-state-machine.js`）が分離されており、遷移の妥当性がテスト付きで保証される。

### 2. セキュリティ基盤が体系的
- 全ルートに JWT 認証（公開パスはアローリスト管理）、RBAC（user/provider/admin）、所有者チェック（`allowOwnerOrAdmin`）。
- シークレットは `requireSecret()` で本番 fail-fast（ハードコードフォールバック撤廃済み）。
- タイミングセーフ比較（API キー・マスター認証）、HS256 固定によるアルゴリズム混同攻撃対策、認証エンドポイントへのブルートフォース対策レートリミット。
- logout によるトークン失効（jti denylist、永続化）。
- 監査ログはハッシュチェーン + Merkle アンカリングで改ざん検知可能。

### 3. 障害耐性を意識したデータ層
- 全 JSON 書込みがアトミック（temp + rename、`atomicWriteJSON`）。読込は JSON.parse ガード付きでファイル破損時も起動継続。
- 世代付きローカルバックアップ + クラウド（S3/Dropbox/GDrive）バックアップ、破損時自動リストア。

### 4. 可観測性
- Prometheus `/metrics`（キャッシュ・チャネル・サービス死活・為替）、`/health` 死活エンドポイント、SLA トラッカー、構造化ログ（winston）、リクエストID伝播。

### 5. オプショナルなインフラ分離
- libp2p / gRPC(LND) / dockerode / k8s は「未導入でも Web API 本体が起動する」ガード付きシングルトン構成（`src/core/services.js`）。503 で明示的にデグレードする。

---

## 短所（Weaknesses）

### 1. データ層が JSON ファイル（スケール限界）
- 全リポジトリが「全件読込 → 配列操作 → 全件書込」。数千件オーダーで線形劣化、プロセス間排他なし（単一プロセス前提）。
- Prisma/knex/pg の残骸が三重化したまま未使用。**対応方針**: 当面は単一ノード運用を明記し、将来 SQLite/Postgres へ移行（フォローアップ）。

### 2. P2P 層が実質無効
- 現行 libp2p は ESM-only で CJS から require 不可。`src/p2p-*.js` は MVP 雛形のまま統合されていない。「P2P マーケットプレイス」を名乗るが、現状は**中央集権 API + 将来の P2P 拡張枠**が実態。

### 3. 決済が実 LND 前提
- Lightning 決済・hold invoice エスクローは LND 未接続時 503。決済なしでも注文フローは動くが、「実際にお金が動く」検証は実環境依存（モック統合テストはあり）。

### 4. フロントエンドが未配線
- `public/` の静的ファイルは最小限。Electron（preload/react-app）は未統合。実用には API クライアントか UI の実装が必要。

### 5. 単一プロセス・単一ノード前提
- レートリミット・キャッシュ・トークン失効リストはすべてインメモリ（+ローカルJSON）。水平スケールには Redis 等の共有ストアが必要。

---

## 不足機能の洗い出しと対応状況

| # | 不足機能 | 重要度 | 状態 |
|---|---------|--------|------|
| 1 | `/health` 死活エンドポイント | 高（sla-tracker が存在しない URL をポーリングし常時 DOWN 判定だった） | ✅ 実装済み |
| 2 | 二重予約防止（同一 GPU への重複注文拒否） | 高（マーケットプレイスの基本整合性） | ✅ 実装済み（409 Conflict） |
| 3 | 未決済注文の自動失効 | 高（放置 pending が GPU を恒久ブロック） | ✅ 実装済み（既定30分、env 可変） |
| 4 | 一覧 API のページネーション | 高（全件返却はスケールしない） | ✅ 実装済み（limit/offset、既定50・上限200） |
| 5 | ログアウト / トークン失効 | 高（漏洩トークンを無効化できなかった） | ✅ 実装済み（jti denylist） |
| 6 | GPU 空き状況の表示・絞り込み | 中 | ✅ 実装済み（`available` フラグ + `?available=true`） |
| 7 | プロバイダ収益サマリ | 中（貸し手が収益を確認できなかった） | ✅ 実装済み（`GET /orders/provider/earnings`） |
| 8 | OpenAPI 仕様の HTTP 公開 | 中 | ✅ 実装済み（`GET /openapi.json`） |
| 9 | 注文一覧キャッシュのユーザー分離 | **致命**（他ユーザーの注文一覧が返る認可バイパスを発見） | ✅ 修正済み（perUser キャッシュキー） |
| 10 | リフレッシュトークン（短命アクセス + 長命リフレッシュ） | 中 | ⏳ フォローアップ |
| 11 | GPU 時間帯予約（スケジュール貸出・カレンダー） | 中（現状は「今すぐ借りる」のみ） | ⏳ フォローアップ |
| 12 | プロバイダ向け通知（注文受付を貸し手へ配送） | 中（通知は運営向け env のみだった） | ✅ 実装済み（`notifyUser` が notification-settings の登録チャネルへ配送） |
| 13 | 管理統計 API（GMV・注文状況・GPU 稼働率） | 低 | ✅ 実装済み（`GET /admin/stats`、admin 限定） |
| 14 | SQLite/Postgres への移行 | 中（スケール時） | ⏳ フォローアップ |
| 15 | E2E 決済テスト（regtest LND） | 中 | ⏳ フォローアップ |

### 実装詳細（今回追加分）

- **二重予約防止**: `POST /orders` が GPU 存在確認後、`pending/matched/active` の既存注文を検査し 409 を返す。検査前に期限切れ pending を失効させるため、放置注文が空き枠を塞がない。
- **自動失効**: `src/utils/order-expiry.js`。`ORDER_PENDING_TIMEOUT_MINUTES`（既定30）を超えた pending を `cancelled`（`cancelReason: 'payment_timeout'`）へ遷移。一覧取得・注文作成時の遅延スイープ方式で、タイマー常駐を増やさない。
- **トークン失効**: ログイン時に `jti` を発行し、`POST /users/logout` で `data/revoked-tokens.json` に exp まで保持。`jwt-auth.js`・`security.js` 両方の検証パスで拒否。
- **キャッシュ認可バイパス修正**: `cacheMiddleware({ perUser: true })` でキャッシュキーにユーザーIDを含める。修正前は 60 秒 TTL 内に別ユーザーへ他人の注文一覧が返っていた。
- **プロバイダ通知**: `src/utils/user-notify.js`。注文作成時に GPU の `providerId` 宛へ、notification-settings で登録済みのチャネル（LINE/Discord/Slack/Telegram/Email/イベント別 Webhook）に配送。`enabled` マップとイベント種別でフィルタ（純関数 `resolveChannels`、単体テスト付き）。
- **管理統計**: `GET /api/v1/admin/stats`。ユーザー数（ロール別）、GPU 総数・稼働/空き、注文状況別件数、完了 GMV（sats/JPY）を返す。

---

## 総評

土台（認証・認可・監査・原子的永続化・状態機械・テスト）は堅牢になった。一方でプロダクトの看板である「P2P」と「Lightning 実決済」は外部依存が未接続のため、現状の実態は**単一ノードの GPU 貸出 REST API + 決済抽象層**である。次の価値順は (1) UI または API クライアント、(2) regtest LND での決済 E2E、(3) 時間帯予約、(4) DB 移行。
