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
| POST `/api/v1/orders/:id/preempt` | Spot 注文の中断通知（猶予窓つき） | JWT+provider/admin | ✅ |
| POST `/api/v1/marketplace/quote`,`/rank` | 特徴量価格/レピュテーション順位 | JWT | ✅ |
| POST `/api/v1/marketplace/auction` | 逆オークション（価格×レピュ×SLA×アテステーション） | JWT | ✅ |
| `/api/v1/marketplace/escrow/*` (open/pay/verify/resolve) | エスクロー駆動 | JWT+admin | 🟡(LN実機未) |
| GET `/api/v1/audit-anchors/latest`,`/{root}/receipt` | 監査ログの外部コミットメント（Merkle root / OTS レシート） | **公開** | ✅ |
| `/api/v1/admin/audit-anchors`,`/run`,`/proof` | アンカー一覧・強制実行・包含証明 | JWT+admin | ✅ |
| `/api/profit-addresses` | 運営受取先 | JWT+admin | ✅ |
| GET `/metrics` | Prometheus | none | ✅ |
| GET `/api/v1/node-info`,`/channels` | LN 情報 | JWT | 🟡(LN実機要) |
| GraphQL `/graphql` | 換算等(orders/users/gpus/exchangeRate) | - | ✅(マウント済, server.js) |

※`users/register` の `userId` 未定義クラッシュ、role 変更/削除の存在しない `users` 配列参照、
グローバル JWT ゲートが register/login も保護していた鶏卵問題は **すべて修正済**（2026-06）。

## 4. コアフロー と 要件ステータス（= gap 分析）

### F1. 出品 → 検索 → 注文 → 決済
1. 出品: Provider が GPU を登録 … ✅ だが **真正性検証なし** ❌（カテゴリ3）
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡 **特徴量/需給価格は `POST /marketplace/quote`・`openOrderEscrow` に配線済**（`feature-pricer`）。注文の実課金経路（`order/index.js`）はまだフラットのまま。
   なお feature-pricer は `vramGB/memBandwidthGBs/benchmarkScore` 語彙、出品レコードは `memoryGB/performance.teraflops` 語彙で噛み合っておらず、実レコードを渡すと全特徴量 0 で見積が価格フロアに張り付いていた。`perf-score.toPricingFeatures()` で橋渡し済（2026-08）。
3. 性能比較: ✅ **正規化性能スコア実装済**（`src/gpu/perf-score.js`、Vast.ai DLPerf 相当）。演算・帯域・VRAM の加重幾何平均で参照GPU(RTX 4090 級)=100 の機種横断指数を算出し、`GET /gpus`・`/gpus/:id` の `performanceScore` と `?sort=perf|value`（価格対性能 = DLPerf/$ 相当）で公開。自己申告での順位買いを防ぐため、参照表と矛盾する申告は表を採用せず（`vram_mismatch`）、申告 TFLOPS は消費電力由来の物理上限でクランプし、未検証の未知型番は参照GPU 超えを認めない。根拠が無い場合はスコアを推測せず null（未算出）。
4. マッチング: 単純検索/ソート … ✅ **逆オークション実装済**（`src/marketplace/auction-engine.js`、Akash/Golem 型。価格・レピュテーション・SLA・アテステーションを統合した効用スコアで勝者選定。`selectProvider`／`POST /api/v1/marketplace/auction`、price-ratio 正規化）
5. 決済: 直接二段送金 `btc-payment.sendBTC` … ❌ **エスクロー無し**（本書で実装）
6. 稼働: `virtual-gpu-manager` でコンテナ割当 … 🟡（要 Docker/k8s 実機）
7. 課金ティア: ✅ **Spot（中断許容）ティア実装済**（`src/marketplace/spot-tier.js`。出品側の
   オプトイン + 割引、猶予窓つき中断 `POST /orders/:id/preempt`、最低課金を効かせない従量按分
   での精算、注文履歴から導出する中断率の開示。Vast.ai interruptible / Bamboo arXiv:2204.12013）
8. 精算: ✅ **従量按分の精算計算実装済**（`src/payments/settlement-calculator.js`。実使用量(heartbeat)＋SLA で payout/refund/fee を分割。最低課金・SLA ペナルティ・整数 sats 保存則。`escrow-service.settle`／`marketplace-service.settleByUsage`）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡 `src/verification/work-verifier.js`（純関数）＋ `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋ `src/db/json/VerificationRepository.js`（永続化）実装済。finalize は escrow.evaluate へ渡せる ctx を返し reputation へ反映。**ルート配線・実ジョブ収集は未**。
- **Lightning エスクロー**: ❌→🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）実装済。**LN実機連携・ルート配線は未**。
- **GPU アテステーション**: ❌（nvtrust 連携未, カテゴリ3）。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: 🟡 `src/reputation/reputation-scorer.js`（算出）＋ `src/reputation/reputation-service.js`（イベント記録）＋ `src/db/json/ReputationRepository.js`（永続化）実装済。**ルート配線は未**。

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **OTel トレース**: ✅（`src/telemetry/instrumentation.js` を
  `src/api/server.js:5` で全 require より先に読み込み済。本書は長らく ❌ と記していたが誤り）/
  **カーボン配置**: ❌
- **監査ログの外部アンカリング**: ✅（2026-08）。
  - 訂正: 本書は以前「`audit-log` 結線済。**残るは OTS への root 実提出のみ**」と書いていたが、
    これは実態より楽観的だった。実際には `anchorAuditLogFile()` が `src/` のどこからも
    呼ばれておらず（テストのみ）、**定期ジョブが無いためアンカーは 1 つも生成されていなかった**。
    アンカーを外部へ公開する経路も無く、root が運営のディスクから出ないため §18 が名指しする
    脅威（運営自身による遡及改ざん）は全く緩和されていなかった。
  - 現状: `src/security/anchor-scheduler.js` が**増分アンカー**を定期生成し（既定 1 時間、
    前回アンカーの byte offset から末尾だけを読む）、`src/security/ots-client.js` が
    Merkle root を**複数の OpenTimestamps カレンダーへ冗長提出**する（`AUDIT_ANCHOR_OTS_ENABLED`
    でオプトイン、fail-soft）。commitment は `GET /api/v1/audit-anchors/latest`（公開）、
    OTS レシートは `GET /api/v1/audit-anchors/{root}/receipt`（公開）で第三者が取得できる。
    admin は一覧・強制実行・包含証明 (`/admin/audit-anchors*`)。
  - **やっていないこと**: OTS バイナリ証明の自前パース／Bitcoin アテステーションの自前検証
    （レシートは不透明に保存し、第三者が標準 `ots verify` で検証する）。連続アンカー間の
    consistency proof（RFC 6962 との差。詳細は `docs/improvement-research-2026.md` §18）。

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
- `src/security/ots-client.js` — OpenTimestamps カレンダー・クライアント（複数カレンダーへ冗長提出、レシートは不透明保存、既定無効・fail-soft・SSRF ガード経由, 10テスト）
- `src/security/anchor-scheduler.js` — 監査ログの定期増分アンカリング（byte offset 再開、簿記エントリでの空回り防止、切詰め検出, 10テスト）
- `src/marketplace/spot-tier.js` — Spot（中断許容）ティアのポリシー（割引・猶予窓・最低課金を効かせない中断精算・中断率の導出, 18テスト）
- `src/gpu/perf-score.js` — 機種横断の正規化性能スコア／価格対性能（DLPerf 風。参照表照合・電力由来の TFLOPS 上限クランプ・未検証型番の上限・算出不能は null、feature-pricer への特徴量変換つき, 27テスト）
