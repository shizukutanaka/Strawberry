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
| **Provider reputation** | stake, slashCount, sla, auditPass/Fail | ReputationRepository | 🟡(永続化+サービス実装, 配線未) |
| **Escrow** | orderId, invoice, state, history, deadline | EscrowRepository | 🟡(永続化+サービス実装, 配線/LN未) |
| **Verification record** | jobId, audited, outputs, consensus, verdict | VerificationRepository | 🟡(永続化+サービス実装, 配線未) |

> データ層は JSON のみ稼働。Prisma/pg/knex は未配線（三重化, `ARCHITECTURE.md`）。並行書込み保護なし=🟡。

## 3. API 仕様（実装ベース）

| メソッド/パス | 役割 | 認証 | ステータス |
|---|---|---|---|
| POST `/api/v1/users/register`,`/login`,`/me` | ユーザ登録/認証 | 一部JWT | ✅(registerに既知バグ※) |
| GET `/api/v1/gpus`, `/gpus/:id` | GPU 検索/詳細 | JWT | ✅(JSON層で動作) |
| POST/PUT `/api/v1/gpus` | 出品登録/更新 | JWT+role | 🟡(アテステーション無し) |
| GET/POST `/api/v1/orders` … `/:id/start` | 注文 | JWT | ✅(現金換算付き) |
| POST `/api/v1/payments/...` | 決済 | JWT | 🟡(エスクロー無し) |
| POST `/api/v1/marketplace/quote`,`/rank` | 特徴量価格/レピュテーション順位 | JWT | ✅ |
| `/api/v1/marketplace/escrow/*` (open/pay/verify/resolve) | エスクロー駆動 | JWT+admin | 🟡(LN実機未) |
| `/api/profit-addresses` | 運営受取先 | JWT+admin | ✅ |
| GET `/metrics` | Prometheus | none | ✅ |
| GET `/api/v1/node-info`,`/channels` | LN 情報 | JWT | 🟡(LN実機要) |
| GraphQL `/graphql` | 換算等 | - | ❌(未マウント) |

※`users/register` は `sanitizeObject`/`userId` 未定義の既存バグ（実行時クラッシュ）=🟡。

## 4. コアフロー と 要件ステータス（= gap 分析）

### F1. 出品 → 検索 → 注文 → 決済
1. 出品: Provider が GPU を登録 … ✅ だが **真正性検証なし** ❌（カテゴリ3）
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡 **特徴量/需給価格は未配線**（`feature-pricer` 実装済・未配線）
3. マッチング: 単純検索/ソート … 🟡 **オークション/レピュテーション重み無し**（カテゴリ4/5）
4. 決済: 直接二段送金 `btc-payment.sendBTC` … ❌ **エスクロー無し**（本書で実装）
5. 稼働: `virtual-gpu-manager` でコンテナ割当 … 🟡（要 Docker/k8s 実機）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡 `src/verification/work-verifier.js`（純関数）＋ `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋ `src/db/json/VerificationRepository.js`（永続化）実装済。finalize は escrow.evaluate へ渡せる ctx を返し reputation へ反映。**ルート配線・実ジョブ収集は未**。
- **Lightning エスクロー**: ❌→🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）実装済。**LN実機連携・ルート配線は未**。
- **GPU アテステーション**: ❌（nvtrust 連携未, カテゴリ3）。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: 🟡 `src/reputation/reputation-scorer.js`（算出）＋ `src/reputation/reputation-service.js`（イベント記録）＋ `src/db/json/ReputationRepository.js`（永続化）実装済。**ルート配線は未**。

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **外部アンカリング(OpenTimestamps)**: ❌ / **OTel トレース**: ❌ / **カーボン配置**: ❌

## 5. 非機能要件

| 要件 | 仕様 | ステータス |
|---|---|---|
| 起動/インストール | `npm install && npm start` で起動、`/metrics`=200 | ✅ |
| 秘密鍵管理 | 本番 fail-fast、ハードコード禁止 | ✅ |
| P2P | libp2p で分散。peer scoring/signed records | ❌(libp2p ESM で無効) |
| テスト | `npm test` 完走、コア green | 🟡(既存 aspirational テスト一部赤) |
| データ整合性 | 注文/決済/残高のトランザクション | ❌(JSON, 並行保護なし) |

## 6. 不足部分の実装計画（優先順）

1. **エスクロー状態機械**（✅実装済）— hold invoice の held→settle/cancel/dispute を純 FSM 化＋永続化サービス。`work-verifier` の検証結果で解放判断。
2. **ドメイン層＋HTTP 配線は実装済**: `src/marketplace/marketplace-service.js` が全フローを合成し、
   `src/api/routes/marketplace.js`（`/api/v1/marketplace/*`）が HTTP で公開
   （quote/rank ＝ JWT、escrow open/pay/verify/resolve ＝ admin）。supertest で
   open→pay→verify→SETTLED を検証済。
   **actions→LN 操作の変換層も実装済**（`src/payments/action-executor.js` ＋
   `src/payments/ln-adapter.js` の MockLnAdapter）。**残るは実 LND/CLN アダプタ実装、
   既存 order/payment ルートからの呼び出し、実ジョブの出力/利用率収集**。← 次の山
3. **永続化エンティティは全て実装済**（Escrow / Provider reputation / Verification record）。将来 Prisma へ移行。
4. GPU アテステーション（nvtrust）、監査ログ OpenTimestamps アンカリング、libp2p ESM 対応。

---

## 付録: 実装済みの再利用可能モジュール（純関数・テスト済）

- `src/verification/work-verifier.js` — Proof-of-Compute 土台（13テスト）
- `src/verification/verification-service.js` ＋ `src/db/json/VerificationRepository.js` — 検証の永続化/verdict 確定（8テスト）
- `src/reputation/reputation-scorer.js` — stake加重レピュテーション（10テスト）
- `src/reputation/reputation-service.js` ＋ `src/db/json/ReputationRepository.js` — レピュテーション永続化/イベント記録（8テスト）
- `src/pricing/feature-pricer.js` — 特徴量ベース価格（7テスト）
- `src/payments/escrow-state-machine.js` — エスクロー FSM（12テスト）
- `src/payments/escrow-service.js` ＋ `src/db/json/EscrowRepository.js` — エスクロー永続化/オーケストレーション（8テスト）
- `src/marketplace/marketplace-service.js` — 全サービスを束ねるドメイン合成層（5テスト, 正常系/不正系の統合）
- `src/payments/action-executor.js` ＋ `src/payments/ln-adapter.js` — escrow actions→LN 操作の変換層＋MockLnAdapter（7テスト）
