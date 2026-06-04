# Strawberry アーキテクチャと現状（2026-06）

このドキュメントは、リポジトリの**実態**を簡潔にまとめたもの。README や
`improvement_checklist2.md` の一部記述は実装より先行（aspirational）しているため、
本ファイルを一次情報として扱うこと。

## 実体は何か

- **本体は Node.js / Express の Web API サーバ**（`src/api/server.js`、`npm start`）。
- Electron 用の `preload.js` / `react-app.tsx` は存在するが **`ipcMain` ハンドラが無く未配線**。
  現状デスクトップアプリとしては動作しない。
- データ永続化は **`src/db/json/*` の JSON ファイルリポジトリが実際に稼働**している層。
  `prisma/`、`knex`/`sqlite3`、`pg`/`ioredis`(`src/core/database.js`) も存在するが
  **未配線・未使用**（三重化）。当面 JSON のみが正。

## 起動パスとサービス

```
src/api/server.js
 ├─ middleware/security, middleware/logger, prom-client(/metrics)
 ├─ /master-auth      → routes/master-auth.js (Google OAuth は env 設定時のみ有効)
 ├─ /api/exchange-rate→ routes/exchange-rate.js
 └─ /api/v1 (routes/index.js)  ※ /system/info 以外は JWT 必須
      ├─ /gpus /orders /payments /users  → JSON リポジトリで動作
      └─ コアサービス: src/core/services.js 経由のガード付きシングルトン
           ├─ virtual-gpu-manager.js (dockerode/k8s)   … optional
           ├─ p2p-network.js (libp2p, **ESM**)          … optional
           └─ lightning-service.js (gRPC)               … optional
```

### コアサービスのガード方針（重要）

`virtual-gpu-manager` / `p2p-network` / `lightning-service` はリポジトリ直下に置かれた
大型モジュールで、ネイティブ/ESM 依存（dockerode・libp2p・gRPC）を持つ。とくに現行
`libp2p` は **ESM 専用で `require()` 不可**。これらをモジュール読込時に `new` していたため、
従来は Web API 全体が起動不能だった。

現在は `src/core/services.js` が全て **try/catch で安全に読み込み、失敗時は `null`**
（無効化モード）にフォールバックする。各サービスを使うエンドポイントは `requireService()`
で **503** を返す。これにより JSON データ層で動く API 本体は常に起動できる。

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

1. インフラ3サービスの配線/検証（libp2p ESM 対応 or 代替、lightning-service の構文/相対パス修正）。
2. データ層を一本化（当面 JSON 維持、将来 Prisma へ。未使用の pg/ioredis/knex/sqlite3 整理）。
3. サービスの DI/シングルトン統一、孤立 `*-fixed.js` の削除。
4. Electron の本実装 or 撤去判断（`ipcMain` か、preload/react-app の削除）。
5. 既存テストの実装整合化（未実装エンドポイント実装 or テスト是正）。
