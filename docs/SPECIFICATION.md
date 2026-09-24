# Strawberry 仕様書（SPECIFICATION）/ 2026-06

P2P GPU マーケットプレイス＋BTC Lightning 決済。本書は**あるべき仕様**を定義し、
各要件に**実装ステータス**を付すことで不足部分（gap）を明示する。
詳細な改善根拠は `docs/improvement-research-2026.md`（18領域）/`docs/category-research-2026.md`（10×10）参照。

ステータス凡例: ✅実装済 / 🟡部分実装・未配線 / ❌未実装

---

## 1. 概要・アクター

- **借り手(Renter)**: GPU 時間を注文し Lightning で支払う。
- **貸し手/プロバイダ(Provider)**: GPU を出品し、稼働に応じて報酬を受け取る。
- **運営(Operator)**: マッチング・決済仲介・手数料(FEE_RATE)を得る。`/api/profit-addresses`(admin)。
- **マスター管理者**: 3重認証(`/master-auth`: Google+TOTP+メール)。

## 2. エンティティ / データモデル（`src/db/json/*`、JSON ファイル）

| エンティティ | 主フィールド | リポジトリ | ステータス |
|---|---|---|---|
| User | id, email, username, password(bcrypt), role | UserRepository | ✅ |
| Gpu | id, vendor, memoryGB, pricePerHour, features, providerId | GpuRepository | ✅ |
| Order | id, userId, gpuId, durationMinutes, status, price | OrderRepository | ✅ |
| Payment | id, orderId, amount, method, status | PaymentRepository | ✅ |
| ~~Provider reputation~~ | — | — | ❌(write-only統計として第9ラウンドで削除) |
| **Escrow** | orderId, invoice, state, history, deadline | EscrowRepository | 🟡(永続化+サービス+HTTP配線済, 実LN未) |
| **Verification record** | jobId, audited, outputs, consensus, verdict | VerificationRepository | 🟡(永続化+サービス+HTTP閲覧配線済, 実ジョブ収集未) |

> データ層は JSON のみ稼働。Prisma/pg/knex は未配線（三重化, `ARCHITECTURE.md`）。並行書込み保護なし=🟡。

## 3. API 仕様（実装ベース）

| メソッド/パス | 役割 | 認証 | ステータス |
|---|---|---|---|
| POST `/api/v1/users/register`,`/login`,`/me` | ユーザ登録/認証 | register/login=公開, me=JWT | ✅ |
| GET `/api/v1/gpus`, `/gpus/:id` | GPU 検索/詳細 | JWT | ✅(JSON層で動作) |
| POST/PUT `/api/v1/gpus` | 出品登録/更新 | JWT+role | 🟡(attestation 検証結線済、nvtrust 実連携未) |
| GET/POST `/api/v1/orders` … `/:id/start` | 注文 | JWT | ✅(create スキーマ不整合/param検証/状態遷移バグ修正済, 統合テスト有) |
| POST `/api/v1/payments/...` | 決済 | JWT | ✅(hold-invoice エスクロー結線済み — FSM+order settle/cancel) |
| ~~POST `/api/v1/marketplace/quote`,`/rank`,`/auction`~~ | 実行時消費者ゼロのマッチング面 — 第8ラウンドで削除 | — | ❌ |
| `/api/v1/marketplace/escrow/*` (open/pay/verify/resolve) | エスクロー駆動 | JWT+admin | 🟡(LN実機未) |
| `/api/profit-addresses` | 運営受取先 | JWT+admin | ✅ |
| GET `/metrics` | Prometheus | none | ✅ |
| GET `/api/v1/payments/node-info`,`/channels`,`/history` | LN 情報 | JWT | 🟡(LN実機要) |

※`users/register` の `userId` 未定義クラッシュ、role 変更/削除の存在しない `users` 配列参照、
グローバル JWT ゲートが register/login も保護していた鶏卵問題は **すべて修正済**（2026-06）。

## 4. コアフロー と 要件ステータス（= gap 分析）

### F1. 出品 → 検索 → 注文 → 決済
1. 出品: Provider が GPU を登録 … ✅（`gpu-attestation-verifier` を出品/バルク登録フローに結線済 — mock verifier、nvtrust ハードウェア連携は未）
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡（`feature-pricer` は marketplace-service 結線済、UI/注文フローでの需給反映は未）
3. マッチング: 単純検索/ソート … ✅（SPA は GPU 一覧+gpuId 明示指定で実現。逆オークション面は実行時消費者ゼロのため削除）
4. 決済: hold-invoice エスクロー … 🟡（FSM＋order settle/cancel＋admin escrow ルート配線済、実 LN ノード連携は未）
5. 稼働: `virtual-gpu-manager` で仮想GPU割当 … 🟡（native プラットフォームのみ。docker/k8s パスは依存未導入のため削除済み）
6. 精算: ✅ **従量按分の精算計算実装済**（`src/payments/settlement-calculator.js`。実使用量(heartbeat)＋SLA で payout/refund/fee を分割。最低課金・SLA ペナルティ・整数 sats 保存則。`escrow-service.settle`／`marketplace-service.settleByUsage`）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡 `src/verification/work-verifier.js`（純関数）＋ `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋ `src/db/json/VerificationRepository.js`（永続化）実装済。finalize は escrow.evaluate へ渡せる ctx を返す。HTTP 閲覧は `/verifications` ルート配線済、**実ジョブ収集は未**。
- **Lightning エスクロー**: 🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）＋ admin escrow ルート配線済。**LN実機連携は未**。
- **GPU アテステーション**: 🟡 `src/security/gpu-attestation-verifier.js` を出品/バルク登録フローに結線済（mock verifier）。**nvtrust ハードウェア連携は未**。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: ❌ 削除（第9ラウンド — イベントは記録されるが決定・表示の読出経路が存在しない write-only サブシステムと判定）

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **外部アンカリング(Merkle root)**: ❌（merkle-anchor/audit-anchor はゼロベース整理で削除 — audit.log の HMAC 連鎖 + integrity 検証のみ生存） / **OTel トレース**: 🟡（`src/telemetry/instrumentation.js` — OTEL_EXPORTER_OTLP_ENDPOINT 設定時のみ有効） / **カーボン配置**: ❌

## 5. 非機能要件

| 要件 | 仕様 | ステータス |
|---|---|---|
| 起動/インストール | `npm install && npm start` で起動、`/metrics`=200 | ✅ |
| 秘密鍵管理 | 本番 fail-fast、ハードコード禁止 | ✅ |
| マスター認証 | 3要素(Google+TOTP+メール)、暗号乱数/定時間比較/TTL | ✅(Math.random/timing/await バグ修正済) |
| CORS | 仕様準拠(ワイルドカード時 credentials 無効) | ✅(修正済) |
| P2P | libp2p で分散。peer scoring/signed records | ❌(libp2p ESM で無効) |
| テスト | `npm test` 完走、コア green | ✅(115スイート/1,045テスト green, 1 skip=env依存) |
| データ整合性 | 注文/決済/残高のトランザクション | ❌(JSON, 並行保護なし) |

## 6. 不足部分の実装計画（優先順）

1. **エスクロー状態機械**（✅実装済）— hold invoice の held→settle/cancel/dispute を純 FSM 化＋永続化サービス。`work-verifier` の検証結果で解放判断。
2. **ドメイン層＋HTTP 配線は実装済**: `src/marketplace/marketplace-service.js` が全フローを合成し、
   `src/api/routes/marketplace.js`（`/api/v1/marketplace/*`）が HTTP で公開
   （escrow open/pay/verify/resolve ＝ admin）。supertest で
   open→pay→verify→SETTLED を検証済。
   **actions→LN 操作の変換層も実装済**（`src/payments/action-executor.js` ＋
   lnAdapter DI — mock は `tests/helpers/mock-ln-adapter.js`）。**残るは実 LND/CLN アダプタ実装、
   実ジョブの出力/利用率収集**。← 次の山
3. **永続化エンティティは全て実装済**（Escrow / Verification record）。将来 Prisma へ移行。
4. GPU アテステーション（nvtrust 実連携）、libp2p ESM 対応、カーボン配置。
   監査ログ Merkle アンカリングは削除済（HMAC 連鎖＋integrity 検証が生存する監査機構）。

---

## 付録: 実装済みの再利用可能モジュール（純関数・テスト済）

- `src/verification/work-verifier.js` — Proof-of-Compute 土台（13テスト）
- `src/verification/verification-service.js` ＋ `src/db/json/VerificationRepository.js` — 検証の永続化/verdict 確定（8テスト）
- `src/pricing/feature-pricer.js` — 特徴量ベース価格（7テスト）
- `src/payments/escrow-state-machine.js` — エスクロー FSM（12テスト）
- `src/payments/escrow-service.js` ＋ `src/db/json/EscrowRepository.js` — エスクロー永続化/オーケストレーション（9テスト）
- `src/payments/settlement-calculator.js` — 従量・SLA 連動の精算分割（payout/refund/fee、最低課金/SLA ペナルティ、整数 sats 保存則, 12テスト）
- `src/marketplace/marketplace-service.js` — エスクロー/検証を束ねるドメイン合成層
- `src/payments/action-executor.js` — escrow actions→LN 操作の変換層（lnAdapter DI、mock は `tests/helpers/mock-ln-adapter.js`）
- `src/security/gpu-attestation-verifier.js` — GPU アテステーション検証（申告 vs 計測, 8チェック, Mock 付き, 20テスト）
