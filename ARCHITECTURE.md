# Strawberry アーキテクチャと現状（2026-06）

このドキュメントは、リポジトリの**実態**を簡潔にまとめたもの。README や
`improvement_checklist2.md` の一部記述は実装より先行（aspirational）しているため、
本ファイルを一次情報として扱うこと。

## 実体は何か

- **本体は Node.js / Express の Web API サーバ**（`src/api/server.js`、`npm start`）。
- Electron 用の `preload.js` / `react-app.tsx`（`ipcMain` ハンドラ無く未配線・デスクトップ
  アプリとして未成立）は削除済み（2026-07）。デスクトップアプリを実装する場合は
  `ipcMain`/`ipcRenderer` の配線から新規に設計すること。
- データ永続化は **`src/db/json/*` の JSON ファイルリポジトリが実際に稼働**している層。
  `prisma/` は依然として存在するが未配線・未使用。`src/core/database.js`
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
           ├─ virtual-gpu-manager.js (dockerode/k8s)   … ロード可（要 Docker/k8s 実機）
           ├─ gpu-detector-extended.js                  … ロード可
           ├─ lightning-service.js (gRPC)               … ロード可（要 LND。未接続時は mock）
           └─ p2p-network.js (libp2p, **ESM**)          … 無効（libp2p が ESM 専用で require 不可）
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

## テスト状況（正直版）

`npm test`（Jest）は完走する。**約半数のスイートが green**（`tests/security/*` 全件、
API スモーク、rbac、gpu、failover、exchange-rate、error-handler 等）。
残りの失敗は**本ブランチの回帰ではなく**、以下いずれかの既存（aspirational）テスト：

- 未実装エンドポイントを叩く（`/notification/create` 等。JWT で 401 になる）。
- 実装と異なる旧 API/スキーマを参照（`validator`・`logger`・`jwt-auth` 等）。
- 実 DB/Prisma 前提（`prisma-basic`・`migration-rollback` は未提供時スキップ化済み）。

実行: `npm install` → `npm test`。サーバ起動確認: `npm start`（`http://localhost:3000`、`/metrics`）。

## フォローアップ（未対応・推奨順）

1. `p2p-network` の有効化（libp2p ESM 対応 or 代替実装）。他3サービスは実機(Docker/k8s/LND)での結合検証。
2. データ層を一本化（当面 JSON 維持、将来 Prisma へ。未使用の pg/ioredis/knex/sqlite3 整理）。
3. サービスの DI/シングルトン統一、孤立 `*-fixed.js` の削除。
4. Electron の本実装 or 撤去判断（`ipcMain` か、preload/react-app の削除）。
5. 既存テストの実装整合化（未実装エンドポイント実装 or テスト是正）。

### 既知の重大ギャップ（要対応・資金フロー）

- **エスクロー action の未配線（money-movement gap）**: `escrow-state-machine` は
  `DELIVER_OK`/`RESOLVE_SETTLE` 等で `reveal_preimage`/`payout_provider`/`collect_fee` の
  「副作用の意図」を返すが、`action-executor.executeActions()` は本番コードのどこからも
  呼ばれていない（テストのみ）。さらに `settle()` が算出する `providerPayoutSats` は
  状態遷移パス（`evaluate`/`verifyAndSettle`）に渡されない。結果、エスクローは
  `SETTLED` でも実際の LN 払い出しが実行されず資金が滞留しうる。LND/CLN アダプタ実装と
  合わせて `evaluate`→`settle`→`executeActions(ctx.payoutSats=settlement.providerPayoutSats)`
  を結線すること。**LN 実機統合を伴う大改修のため本ブランチでは未着手**。
- **JSON 層のクロスプロセス lost-update**: `createJsonRepository` の書き込みは
  temp+rename で単一プロセス内は原子的だが、PM2 クラスタ等の複数ワーカーでは
  flock 相当のクロスプロセス排他がないため「両者 load → 別キー更新 → 後勝ち rename」で
  更新消失が起こりうる。マルチプロセス運用前に flock もしくは単一ライタープロセス化が必要。
  （単一プロセス運用では問題なし。`profit-addresses`/`peerID`/`notification-settings` は
  プロセス内 `withLock` で直列化済み。）
