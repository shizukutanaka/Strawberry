# Strawberry アーキテクチャと現状（2026-09）

このドキュメントは、リポジトリの**実態**を簡潔にまとめたもの。README や
`improvement_checklist2.md` の一部記述は実装より先行（aspirational）しているため、
本ファイルを一次情報として扱うこと。

**2026-09 第一原理レビュー実施**（詳細: `docs/ZERO_BASED_REVIEW.md`）:
エントリポイントから到達不能なモジュール 38 件（src の約 19%・3,359 行）、
GraphQL エンドポイント（コンシューマーゼロ）、未配線の prisma/、Electron 残片、
未使用 optionalDeps（aws-sdk/imagemin 系）を削除。エスクローの LN アクション実行を
`createEscrowService({ lnAdapter })` 経由で結線した（LND 未配備時は従来どおり no-op）。

## 実体は何か

- **本体は Node.js / Express の Web API サーバ**（`src/api/server.js`、`npm start`）。
- Electron 断片（`public/preload.js` / `public/electron.js` / `src/web/`）は
  2026-09 に完全削除済み。デスクトップアプリを実装する場合は
  `ipcMain`/`ipcRenderer` の配線から新規に設計すること。
- **`public/` は実際に動くフロントエンド**（2026-07 追加）。ビルド不要の静的SPA
  （素の HTML + CSS + ネイティブ ES modules、依存追加ゼロ）。`http://localhost:3000`
  で登録/ログイン・GPUマーケット閲覧・注文（Lightning/銀行振込決済含む）・稼働中セッション
  （ハートビート・停止）・レビュー・係争の申請/管理者裁定・管理者の決済承認まで、実際に
  画面から一通り操作できる（以前は `public/index.html` が1行の空スタブで、ブラウザで
  見える画面が存在しなかった）。`#/`始まりのハッシュルーティング（`public/js/router.js`）。
  厳格CSP（`script-src 'self'` のみ、インラインスクリプト禁止）に対応済み。`/swagger.html`
  も同様の理由で CDN+インライン版から同一オリジンの自前ビューア（`public/js/docs.js`）に
  置換済み。未実装: GPU接続情報の実配信（`accessInfo.deliveryImplemented` が false の間は
  その旨を正直に表示するのみ）。
- データ永続化は **`src/db/json/*` の JSON ファイルリポジトリが実際に稼働**している層。
  `prisma/` は未配線のまま 2026-09 に削除済み（将来 DB 移行する場合は
  実ドメインモデルのスキーマ設計から）。`src/core/database.js`
  （`pg`/`ioredis` — いずれもパッケージ未インストール）と `src/core/security.js`
  （`ioredis`/`rate-limiter-flexible` も未インストール）はどこからも import されず、
  かつ依存先パッケージ自体が存在しないため import すれば即座に失敗するコードだった。
  `knex`/`sqlite3` 依存とあわせて削除済み（2026-07）。当面 JSON のみが正。

## 起動パスとサービス

```
src/api/server.js
 ├─ middleware/security, middleware/logger, prom-client(/metrics)
 ├─ /master-auth      → routes/master-auth.js (Google OAuth は env 設定時のみ有効)
 ├─ /api/exchange-rate→ routes/exchange-rate.js
 └─ /api/v1 (routes/index.js)  ※ /system/info 以外は JWT 必須
      ├─ /gpus /orders /payments /users  → JSON リポジトリで動作
      └─ コアサービス: src/core/services.js 経由のガード付きシングルトン
           ├─ virtual-gpu-manager.js (native のみ)     … ロード可
           ├─ gpu-detector-extended.js                  … ロード可
           └─ lightning-service.js (gRPC)               … ロード可（要 LND。未接続時は mock）
```

### コアサービスのガード方針（重要）

`virtual-gpu-manager` / `p2p-network` / `lightning-service` はリポジトリ直下に置かれた
大型モジュールで、ネイティブ/ESM 依存（dockerode・libp2p・gRPC）を持つ。とくに現行
`libp2p` は **ESM 専用で `require()` 不可**。これらをモジュール読込時に `new` していたため、
従来は Web API 全体が起動不能だった。

現在は `src/core/services.js` が全て **try/catch で安全に読み込み、失敗時は `null`**
（無効化モード）にフォールバックする。各サービスを使うエンドポイントは `requireService()`
で **503** を返す。これにより JSON データ層で動く API 本体は常に起動できる。

コードレビュー後の修正で、`virtual-gpu-manager` / `gpu-detector-extended` /
`lightning-service` の読込阻害バグ（誤った `../utils/logger` 相対パス、
`child_process.promises`・`fs.promises` 誤用、`lightning-service` のブレース不整合に
よる構文エラー）を解消し、これら3つは**ロード・インスタンス化が可能**になった
（実機能は Docker/k8s・LND 実機が必要。`virtual-gpu-manager` のコマンド実行は
識別子サニタイズ済み）。`p2p-network` のみ **libp2p が ESM 専用で `require()` 不可**の
ため依然無効。

これらインフラ系依存は `package.json` の `optionalDependencies`（libp2p 一式は未宣言）に置く。

## このブランチで修正した主な内容

- **起動・インストール可能化**: 未宣言依存を `package.json` に追加、`main` を実在エントリへ修正、
  `server.js` の起動クラッシュ（`masterAuth.router` 参照ミス・require の TDZ）と
  各ルートの未 import（`Joi` / `allowOwnerOrAdmin` / `asyncHandler`）・二重宣言（`Joi`）、
  `security.js` の未定義 export（`apiKeyAuth`）、`lru-cache` v10 API、`child_process.promises`、
  `validator.js` の二重 `const Joi` などを修正。`server.js` は直接実行時のみ listen。
- **重大セキュリティ修正**:
  - ハードコード秘密鍵フォールバック廃止 → `config.requireSecret()` で本番 fail-fast / 開発は一時鍵。
  - `routes/profit-addresses.js`（運営受取アドレス）に `jwtAuth + admin` を必須化。
  - `btc-payment.sendBTC` の `dummy-txid` 成功偽装を廃止し、失敗は例外伝播。
  - `virtual-gpu-manager` のシェル実行を識別子サニタイズでインジェクション対策。
  - `.env.example` に必須 env を明記。

## テスト状況（2026-09 実測）

`npm test`（Jest）は完走し、**全スイート green**（136/138、2 件スキップ、1,213 テスト、
約 112 秒）。以前記載されていた「約半数の失敗」は既に是正済みで、到達不能モジュールと
その専用テストは削除した（failover/gpu-*/security-*/prisma 前提テスト等）。

実行: `npm install` → `npm test`。サーバ起動確認: `npm start`（`http://localhost:3000` で
実際に動くマーケットプレイスUIが表示される。`/metrics` はPrometheusメトリクス、
`/swagger.html` はAPIドキュメント）。

## フォローアップ（未対応・推奨順）

1. ~~`p2p-network` の有効化~~ → ファイル削除済み（libp2p 未導入で実行不能。必要なら git 履歴から復元）。LND 実機での結合検証は残課題。
2. ~~データ層を一本化~~ → **方針決定済み（2026-09）**: 当面 JSON のみ。`prisma/` は削除済み。
   将来 DB 化するなら実ドメインのスキーマ設計から新規に行う。
3. サービスの DI/シングルトン統一、孤立 `*-fixed.js` の削除。
4. ~~Electron の本実装 or 撤去判断~~ → **解決済み**: Electron 断片は全削除済み（2026-09 に
   public/ 配下の残片も除去）。
5. ~~既存テストの実装整合化~~ → **解決済み**: 現在 `npm test` は全スイート green（136/138、
   2 件スキップ）。到達不能モジュールとその専用テストは削除済み。
6. `.github/workflows/ci.yml` のデプロイ手順を Docker ビルド+`/health` スモークテストへ置換
   （2026-07、diff はコミット履歴に用意済みだが `workflows` 権限が無い環境からはプッシュ不可
   だったため未適用。`workflows` 権限を持つ人が手動適用する必要あり）。旧手順は存在しない
   `build/` への `netlify deploy` で、ステートフルな Express アプリには元々デプロイ先として
   不適切だった。

### 既知の重大ギャップ（要対応・資金フロー）

- **エスクロー LN アクションの実行経路（2026-09 結線済み）**: 全 9 箇所の本番
  `createEscrowService()` 呼び出しに `lnAdapter`（ガード付き lightning シングルトン =
  LightningService。`settleHoldInvoice`/`cancelHoldInvoice`/`payInvoice` を実装済み）を
  注入した。LND 未配備環境では adapter が null のため従来どおり no-op。配備環境では
  settle/cancel/release の実 LN 操作が実行され、結果はエスクロー履歴
  （`LN_ACTIONS_EXECUTED`/`LN_ACTIONS_FAILED`）に記録される。コンテキスト
  （preimage/preimageHash/providerInvoice）を持たない帳簿専用エスクローの action は
  `skipped` として履歴に記録する。**残ギャップ**: エスクローに `providerInvoice`/
  `preimage` を設定する入口が本番コードに存在しない — LN 払い出しを本稼働させるには
  「プロバイダの payout インボイス/アドレス収集」機能が別途必要。
- **JSON 層のクロスプロセス lost-update**: `createJsonRepository` の書き込みは
  temp+rename で単一プロセス内は原子的だが、PM2 クラスタ等の複数ワーカーでは
  flock 相当のクロスプロセス排他がないため「両者 load → 別キー更新 → 後勝ち rename」で
  更新消失が起こりうる。マルチプロセス運用前に flock もしくは単一ライタープロセス化が必要。
  （単一プロセス運用では問題なし。`profit-addresses`/`peerID`/`notification-settings` は
  プロセス内 `withLock` で直列化済み。）
