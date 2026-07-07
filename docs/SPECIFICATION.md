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
| POST `/api/v1/users/register`,`/login`,`/me` | ユーザ登録/認証 | register/login=公開, me=JWT | ✅ |
| GET `/api/v1/gpus`, `/gpus/:id` | GPU 検索/詳細 | JWT | ✅(JSON層で動作) |
| POST/PUT `/api/v1/gpus` | 出品登録/更新 | JWT+role | 🟡(アテステーション無し) |
| GET/POST `/api/v1/orders` … `/:id/start` | 注文 | JWT | ✅(create スキーマ不整合/param検証/状態遷移バグ修正済, 統合テスト有) |
| POST `/api/v1/payments/...` | 決済 | JWT | 🟡(エスクロー無し) |
| POST `/api/v1/marketplace/quote`,`/rank` | 特徴量価格/レピュテーション順位 | JWT | ✅ |
| POST `/api/v1/marketplace/auction` | 逆オークション（価格×レピュ×SLA×アテステーション） | JWT | ✅ |
| `/api/v1/marketplace/escrow/*` (open/pay/verify/resolve) | エスクロー駆動 | JWT+admin | 🟡(LN実機未) |
| `/api/profit-addresses` | 運営受取先 | JWT+admin | ✅ |
| GET `/metrics` | Prometheus | none | ✅ |
| GET `/api/v1/node-info`,`/channels` | LN 情報 | JWT | 🟡(LN実機要) |
| GraphQL `/graphql` | 換算等(orders/users/gpus/exchangeRate) | - | ✅(マウント済, server.js) |

※`users/register` の `userId` 未定義クラッシュ、role 変更/削除の存在しない `users` 配列参照、
グローバル JWT ゲートが register/login も保護していた鶏卵問題は **すべて修正済**（2026-06）。

## 4. コアフロー と 要件ステータス（= gap 分析）

### F1. 出品 → 検索 → 注文 → 決済
1. 出品: Provider が GPU を登録 … ✅ だが **真正性検証なし** ❌（カテゴリ3）
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡 **特徴量/需給価格は未配線**（`feature-pricer` 実装済・未配線）
3. マッチング: 単純検索/ソート … ✅ **逆オークション実装済**（`src/marketplace/auction-engine.js`、Akash/Golem 型。価格・レピュテーション・SLA・アテステーションを統合した効用スコアで勝者選定。`selectProvider`／`POST /api/v1/marketplace/auction`、price-ratio 正規化）
4. 決済: 直接二段送金 `btc-payment.sendBTC` … ❌ **エスクロー無し**（本書で実装）
5. 稼働: `virtual-gpu-manager` でコンテナ割当 … 🟡（要 Docker/k8s 実機）
6. 精算: ✅ **従量按分の精算計算実装済**（`src/payments/settlement-calculator.js`。実使用量(heartbeat)＋SLA で payout/refund/fee を分割。最低課金・SLA ペナルティ・整数 sats 保存則。`escrow-service.settle`／`marketplace-service.settleByUsage`）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡 `src/verification/work-verifier.js`（純関数）＋ `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋ `src/db/json/VerificationRepository.js`（永続化）実装済。finalize は escrow.evaluate へ渡せる ctx を返し reputation へ反映。**ルート配線・実ジョブ収集は未**。
- **Lightning エスクロー**: ❌→🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）実装済。**LN実機連携・ルート配線は未**。
- **GPU アテステーション**: ❌（nvtrust 連携未, カテゴリ3）。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: 🟡 `src/reputation/reputation-scorer.js`（算出）＋ `src/reputation/reputation-service.js`（イベント記録）＋ `src/db/json/ReputationRepository.js`（永続化）実装済。**ルート配線は未**。

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **外部アンカリング(Merkle root)**: 🟡 `src/security/merkle-anchor.js`(root/証明/検証/digest) ＋ `src/security/audit-anchor.js`（audit.log を読みアンカー生成・永続化・包含証明、audit-log 結線済）。**残るは OTS への root 実提出のみ** / **OTel トレース**: ❌ / **カーボン配置**: ❌

## 5. 非機能要件

| 要件 | 仕様 | ステータス |
|---|---|---|
| 起動/インストール | `npm install && npm start` で起動、`/metrics`=200 | ✅ |
| 秘密鍵管理 | 本番 fail-fast、ハードコード禁止 | ✅ |
| マスター認証 | 3要素(Google+TOTP+メール)、暗号乱数/定時間比較/TTL | ✅(Math.random/timing/await バグ修正済) |
| CORS | 仕様準拠(ワイルドカード時 credentials 無効) | ✅(修正済) |
| P2P | libp2p で分散。peer scoring/signed records | ❌(libp2p ESM で無効) |
| テスト | `npm test` 完走、コア green | ✅(40スイート/215テスト green, 2 skip=env依存) |
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
4. GPU アテステーション（nvtrust）、libp2p ESM 対応、OTel トレース、カーボン配置。
   監査ログ Merkle アンカリングは `merkle-anchor.js` 実装済（残るは OTS への実提出と audit.js 結線）。

---

## 付録: 実装済みの再利用可能モジュール（純関数・テスト済）

- `src/verification/work-verifier.js` — Proof-of-Compute 土台（13テスト）
- `src/verification/verification-service.js` ＋ `src/db/json/VerificationRepository.js` — 検証の永続化/verdict 確定（8テスト）
- `src/reputation/reputation-scorer.js` — stake加重レピュテーション（10テスト）
- `src/reputation/reputation-service.js` ＋ `src/db/json/ReputationRepository.js` — レピュテーション永続化/イベント記録（8テスト）
- `src/pricing/feature-pricer.js` — 特徴量ベース価格（7テスト）
- `src/payments/escrow-state-machine.js` — エスクロー FSM（12テスト）
- `src/payments/escrow-service.js` ＋ `src/db/json/EscrowRepository.js` — エスクロー永続化/オーケストレーション（9テスト）
- `src/payments/settlement-calculator.js` — 従量・SLA 連動の精算分割（payout/refund/fee、最低課金/SLA ペナルティ、整数 sats 保存則, 12テスト）
- `src/marketplace/marketplace-service.js` — 全サービスを束ねるドメイン合成層（6テスト, 正常系/不正系/オークション統合）
- `src/marketplace/auction-engine.js` — 逆オークション・マッチング（価格×レピュ×SLA×アテステーション、price-ratio 正規化、reserve/minReputation/requireAttestation フィルタ, 13テスト）
- `src/payments/action-executor.js` ＋ `src/payments/ln-adapter.js` — escrow actions→LN 操作の変換層＋MockLnAdapter（7テスト）
- `src/security/merkle-anchor.js` — 監査ログ Merkle アンカリング（root/包含証明/検証/digest, 6テスト）
- `src/security/audit-anchor.js` — audit.log → Merkle アンカー生成・永続化・包含証明（audit-log 結線、増分 fromIndex/toIndex, 12テスト）
- `src/security/gpu-attestation-verifier.js` — GPU アテステーション検証（申告 vs 計測, 8チェック, Mock 付き, 20テスト）
