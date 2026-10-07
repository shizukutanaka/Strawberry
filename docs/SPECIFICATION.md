# Strawberry 仕様書（SPECIFICATION）/ 2026-06

P2P GPU マーケットプレイス＋BTC Lightning 決済。本書は**あるべき仕様**を定義し、
各要件に**実装ステータス**を付すことで不足部分（gap）を明示する。
詳細な改善根拠は `docs/improvement-research-2026.md`（18領域）/`docs/category-research-2026.md`（10×10）参照。

ステータス凡例: ✅実装済 / 🟡部分実装・未配線 / ❌未実装

> **2026-09 追補**: 各ステータスを 2026-09 時点の main に合わせて更新済み。当初記述（2026-06）からエスクロー/アテステーション/レピュテーションのルート配線、OTel 計装、feature-pricer 配線が進んだため、該当行のステータスを訂正している。配線のみ未マージ PR に存在する機能は「未」のままとする。

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
| **Provider reputation** | stake, slashCount, sla, auditPass/Fail | ReputationRepository | 🟡(GPU 出品アテステーション・provider-uptime 経由で部分配線済) |
| **Escrow** | orderId, invoice, state, history, deadline | EscrowRepository | 🟡(on-chain BTC 支払い・marketplace/escrow/* へ配線済。LN hold-invoice 実機連携は未) |
| **Verification record** | jobId, audited, outputs, consensus, verdict | VerificationRepository | 🟡(admin 閲覧 API `/admin/verifications` 配線済。実ジョブ収集フローは未) |

> データ層は JSON のみ稼働。Prisma/pg/knex は未配線（三重化, `ARCHITECTURE.md`）。書込みは `withLock` 直列化・`updateIf` CAS・`atomicWriteJSON` でプロセス内は保護済み。クロスプロセスのファイルロックのみ未=🟡。

## 3. API 仕様（実装ベース）

| メソッド/パス | 役割 | 認証 | ステータス |
|---|---|---|---|
| POST `/api/v1/users/register`,`/login`,`/me` | ユーザ登録/認証 | register/login=公開, me=JWT | ✅ |
| GET `/api/v1/gpus`, `/gpus/:id` | GPU 検索/詳細 | JWT | ✅(JSON層で動作) |
| POST/PUT `/api/v1/gpus` | 出品登録/更新 | JWT+role | 🟡(Mock アテステーション verifier 配線済、nvtrust 実機未) |
| GET/POST `/api/v1/orders` … `/:id/start` | 注文 | JWT | ✅(create スキーマ不整合/param検証/状態遷移バグ修正済, 統合テスト有) |
| POST `/api/v1/payments/...` | 決済 | JWT | ✅(on-chain BTC はエスクロー連携済) |
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
1. 出品: Provider が GPU を登録 … 🟡 Mock アテステーション検証を登録フローへ配線済（`gpu-attestation-verifier`、nvtrust 実機連携は未・カテゴリ3）
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡 `feature-pricer` は `marketplace-service.computePrice` 経由で配線済（marketplace/quote, rank）。需給連動 engine（`market-pricing-engine`）は estimate エンドポイントへ advisory 配線済
3. マッチング: 単純検索/ソート … ✅ **逆オークション実装済**（`src/marketplace/auction-engine.js`、Akash/Golem 型。価格・レピュテーション・SLA・アテステーションを統合した効用スコアで勝者選定。`selectProvider`／`POST /api/v1/marketplace/auction`、price-ratio 正規化）
4. 決済: 直接二段送金 `btc-payment.sendBTC` … ✅→🟡 **エスクロー実装済**（`payment/btc-onchain.js` の注文支払いと `marketplace/escrow/*` で EscrowRepository を駆動。LN hold-invoice 実機連携のみ未）
5. 稼働: `virtual-gpu-manager` でコンテナ割当 … 🟡（要 Docker/k8s 実機）
6. 精算: ✅ **従量按分の精算計算実装済**（`src/payments/settlement-calculator.js`。実使用量(heartbeat)＋SLA で payout/refund/fee を分割。最低課金・SLA ペナルティ・整数 sats 保存則。`escrow-service.settle`／`marketplace-service.settleByUsage`）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡 `src/verification/work-verifier.js`（純関数）＋ `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋ `src/db/json/VerificationRepository.js`（永続化）実装済。finalize は escrow.evaluate へ渡せる ctx を返し reputation へ反映。admin 閲覧 API（`/api/v1/admin/verifications`）配線済。**実ジョブ収集・order スコープの検証 API は未**。
- **Lightning エスクロー**: 🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）実装済。`payment/btc-onchain.js`・`marketplace/escrow/*`（admin）へルート配線済。**残るは実 LND/CLN アダプタ**。
- **GPU アテステーション**: 🟡 `gpu-attestation-verifier.js` の Mock verifier を出品登録へ配線済（`POST /gpus` の `attestationReport` → 検証結果を GPU へ保存・reputation へ記録）。**nvtrust 等の実機アテステーション連携は未**（カテゴリ3）。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: 🟡 `src/reputation/reputation-scorer.js`（算出）＋ `src/reputation/reputation-service.js`（イベント記録）＋ `src/db/json/ReputationRepository.js`（永続化）実装済。GPU 出品アテステーション結果と `provider-uptime`（稼働実績）経由で部分配線済。**marketplace rank/auction での実レピュテーション参照は局所的**。

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **外部アンカリング(Merkle root)**: 🟡 `src/security/merkle-anchor.js`(root/証明/検証/digest) ＋ `src/security/audit-anchor.js`（audit.log を読みアンカー生成・永続化・包含証明、audit-log 結線済）。**残るは OTS への root 実提出のみ** / **OTel トレース**: ✅（`src/telemetry/instrumentation.js` を server.js 先頭で auto-instrumentation 読込）/ **カーボン配置**: ❌

## 5. 非機能要件

| 要件 | 仕様 | ステータス |
|---|---|---|
| 起動/インストール | `npm install && npm start` で起動、`/metrics`=200 | ✅ |
| 秘密鍵管理 | 本番 fail-fast、ハードコード禁止 | ✅ |
| マスター認証 | 3要素(Google+TOTP+メール)、暗号乱数/定時間比較/TTL | ✅(Math.random/timing/await バグ修正済) |
| CORS | 仕様準拠(ワイルドカード時 credentials 無効) | ✅(修正済) |
| P2P | libp2p で分散。peer scoring/signed records | ❌(libp2p 系パッケージ未導入＋旧APIのまま。p2p-network は未導入時 degrade) |
| テスト | `npm test` 完走、コア green | ✅(257スイート・約2040テスト green, env依存の一部skipあり, 2026-10 時点) |
| データ整合性 | 注文/決済/残高のトランザクション | 🟡(`updateIf` CAS・`withLock` プロセス内直列化・atomicWrite 済。クロスプロセスロック/実 DB 移行は未) |

## 6. 不足部分の実装計画（優先順）

1. **エスクロー状態機械**（✅実装済）— hold invoice の held→settle/cancel/dispute を純 FSM 化＋永続化サービス。`work-verifier` の検証結果で解放判断。
2. **ドメイン層＋HTTP 配線は実装済**: `src/marketplace/marketplace-service.js` が全フローを合成し、
   `src/api/routes/marketplace.js`（`/api/v1/marketplace/*`）が HTTP で公開
   （quote/rank ＝ JWT、escrow open/pay/verify/resolve ＝ admin）。supertest で
   open→pay→verify→SETTLED を検証済。
   **actions→LN 操作の変換層も実装済**（`src/payments/action-executor.js` ＋
   `src/payments/ln-adapter.js` の MockLnAdapter）。order/payment ルートからの
   エスクロー呼び出しも btc-onchain で配線済。**残るは実 LND/CLN アダプタ実装と
   実ジョブの出力/利用率収集**。← 次の山
3. **永続化エンティティは全て実装済**（Escrow / Provider reputation / Verification record）。将来 Prisma へ移行。
4. GPU アテステーション（nvtrust）、libp2p ESM 対応、OTel トレース、カーボン配置。
   監査ログ Merkle アンカリングは `merkle-anchor.js`＋`audit-anchor.js` 実装済・audit.js 結線済（残るは OTS への実提出のみ）。

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
