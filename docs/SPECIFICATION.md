# Strawberry 仕様書（SPECIFICATION）/ 2026-06

GPU マーケットプレイス（運営者仲介・カストディアル）＋BTC Lightning 決済。本書は**あるべき仕様**を定義し、
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
| **Provider reputation** | stake, slashCount, sla, auditPass/Fail | ReputationRepository | ✅(注文完了・ゼロ負荷監査・係争裁定から記録、`sort=recommended` と `/rank` が参照) |
| **Escrow** | orderId, invoice, state, history, deadline | EscrowRepository | 🟡(永続化+サービス実装, 配線/LN未) |
| **Verification record** | jobId, audited, outputs, consensus, verdict | VerificationRepository | 🟡(`POST /marketplace/escrow/:id/verify` から配線済。実ジョブ出力の収集経路は未) |

> データ層は JSON のみ稼働（Prisma/pg/knex は削除済, 2026-08）。クロスプロセスの並行書込みは
> `src/db/json/fileLock.js` で保護済み（子プロセスを実起動する回帰テスト付き）。
> 複数レコードにまたがるトランザクションは未対応=🟡。

## 3. API 仕様（実装ベース）

| メソッド/パス | 役割 | 認証 | ステータス |
|---|---|---|---|
| POST `/api/v1/users/register`,`/login`,`/me` | ユーザ登録/認証 | register/login=公開, me=JWT | ✅ |
| GET `/api/v1/gpus`, `/gpus/:id` | GPU 検索/詳細 | JWT | ✅(JSON層で動作) |
| POST/PUT `/api/v1/gpus` | 出品登録/更新（必須は name/vendor/model/memoryGB/pricePerHour の 5 項目。apiType/arch/powerWatt は機種から導出し `derivedFields` に記録） | JWT+role | 🟡(アテステーション無し) |
| GET/POST `/api/v1/orders` … `/:id/start` | 注文 | JWT | ✅(create スキーマ不整合/param検証/状態遷移バグ修正済, 統合テスト有) |
| POST `/api/v1/payments/...` | 決済（借り手→運営の受取） | JWT | ✅ |
| GET `/api/v1/payments/earnings` | 受取可能残高と台帳明細 | JWT | ✅ |
| POST/GET `/api/v1/payments/payouts` | 出金申請・自分の申請一覧 | JWT | ✅ |
| `/api/v1/payments/admin/payouts`,`/:id/complete`,`/:id/reject` | 出金待ち一覧・送金記録・却下 | JWT+admin | 🟡(送金は運営が手動実行し txid を記録) |
| POST `/api/v1/payments/admin/earnings/sweep` | 完了注文の収益計上を即時実行 | JWT+admin | ✅ |
| GET `/api/v1/payments/admin/reconciliation` | 帳簿の突き合わせ（預かり債務と 3 つの不変条件） | JWT+admin | ✅ |
| POST `/api/v1/orders/:id/preempt` | Spot 注文の中断通知（猶予窓つき） | JWT+provider/admin | ✅ |
| POST `/api/v1/orders/:id/access` | GPU接続情報の投入 | JWT+provider/admin | ✅ |
| GET `/api/v1/orders/:id/access` | GPU接続情報の受け取り | JWT+**借り手のみ**・支払い済み・稼働中 | ✅ |
| POST `/api/v1/marketplace/quote`,`/rank` | 特徴量価格/レピュテーション順位 | JWT | ✅ |
| GET `/api/v1/gpus?sort=recommended` | 出品の総合順位（価格×レピュ×稼働×アテステーション） | JWT | ✅ |
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
2. 価格: 現状 `pricePerHour/12` のフラット … 🟡 **特徴量/需給価格（`feature-pricer`）は助言用であって課金経路ではない**。`POST /marketplace/quote` から取れるが UI からは呼ばれておらず（`public/` に出現ゼロ）、`openOrderEscrow` も見積額を注文の `totalPrice` で上書きする（`routes/marketplace.js:118`）。したがって feature-pricer は現時点で**値段を一つも決めていない**。注文の実課金経路（`order/index.js`）はフラットのまま。
   なお feature-pricer は `vramGB/memBandwidthGBs/benchmarkScore` 語彙、出品レコードは `memoryGB/performance.teraflops` 語彙で噛み合っておらず、実レコードを渡すと全特徴量 0 で見積が価格フロアに張り付いていた。`perf-score.toPricingFeatures()` で橋渡し済（2026-08）。
3. 性能比較: ✅ **正規化性能スコア実装済**（`src/gpu/perf-score.js`、Vast.ai DLPerf 相当）。演算・帯域・VRAM の加重幾何平均で参照GPU(RTX 4090 級)=100 の機種横断指数を算出し、`GET /gpus`・`/gpus/:id` の `performanceScore` と `?sort=perf|value`（価格対性能 = DLPerf/$ 相当）で公開。自己申告での順位買いを防ぐため、参照表と矛盾する申告は表を採用せず（`vram_mismatch`）、申告 TFLOPS は消費電力由来の物理上限でクランプし、未検証の未知型番は参照GPU 超えを認めない。根拠が無い場合はスコアを推測せず null（未算出）。
4. マッチング: 借り手が一覧から選び、貸し手が承認する。✅ **総合順位付けを実装**（`GET /gpus?sort=recommended`。価格・レピュテーション・稼働実績・アテステーションを統合した効用スコアで実在の出品を並べる。計算は `src/marketplace/auction-engine.js`）。
   なお**逆オークション（入札）は削除した**。この製品には入札を保存する場所も、貸し手が借り手の要件を見る画面も無く、旧 `POST /marketplace/auction` は入札内容を呼び出し側が捏造できた（2026-08）。
5. 決済: Lightning／銀行振込は運営がいったん預かり、**収益台帳**（`src/payments/payout-ledger.js`）で
   貸し手の取り分と借り手への返金を計上し、出金申請 → 運営が送金 → txid 記録という流れ ✅。
   帳簿は 3 つの不変条件で自動突き合わせ（`src/payments/reconciliation.js`）。
   決済経路は Lightning 1 本に統合済（2026-09）。かつて併存した `POST /payment/btc`
   （btc-onchain）は**削除した**。理由は 3 つで、いずれも「オンチェーン BTC 決済」という
   要件自体が成立していなかったことに帰着する:
   (a) オンチェーンではなかった（`sendBTC` は Lightning API を呼ぶだけ）、
   (b) 支払い時点で——GPU 起動前に——プロバイダへ全額を送っており、従量按分・SLA ペナルティ・
   係争返金・Spot 中断按分をすべて迂回していた（借り手が返金裁定を得ても原資が無い）、
   (c) その送金は台帳に行を書かないため、注文完了時に収益台帳が**もう一度**同額を計上し、
   プロバイダは送金と台帳残高の両方を受け取れた。しかも突き合わせは支払記録と台帳しか
   見ないので healthy を返し続けた（帳簿は合っていた。合っていなかったのは現金である）。
   加えて手数料が上乗せ式（借り手に totalPrice×1.015 を請求）で Lightning 経路の控除式と
   逆であり、**同じ注文が経路によって値段の違うものになっていた**。
   同じ穴が生の BOLT11 パススルーにも 2 本あった（`POST /payment`・`POST /payments/pay`）。
   admin 限定ではあったが、送金しても台帳の payout 行を書かないため、送っても残高が減らず
   プロバイダは同じ額をもう一度申請できた。これも削除し、**外部へ資金が出る経路は
   `POST /payments/admin/payouts/:id/complete` 一本**にした。出金申請の行が無ければ送れない
   （`{txid}` で運営が送った証跡を記録するか、`{paymentRequest}` でサーバが LND 経由で払い
   実 payment hash を記録するか。後者は送金前にインボイス額が申請額以下であることを確認し、
   送金と台帳の確定を同じロックの中で行う）。
   現在は「金が動くなら必ず台帳の行になる／台帳の行には必ず実送金の証跡がある」の両方向を
   検査している（`tests/payments/no-unledgered-money.test.js`、不変条件 `noUnbackedPayouts`）✅。
   検査は送金メソッドの一覧を手で持たず**ソースから導出する**——最初の版は手で並べたために
   上記 2 本を見逃した。列挙は必ず古くなる。
6. 稼働・アクセス受け渡し: ✅ **実装済（2026-08）**。従来は `virtual-gpu-manager` が
   マーケットプレイス GPU を「割り当てる」ことになっていたが、サーバは他人のマシンに権限が
   無いため `endpoint: null` しか返せず、**支払っても借りられなかった**（要件の誤り）。
   現在は `src/marketplace/access-delivery.js` で「プロバイダが配信・サーバが仲介」に訂正済:
   `POST /orders/:id/access`（プロバイダ）→ `GET /orders/:id/access`（支払い済みの借り手のみ）。
   credential は AES-256-GCM で暗号化保存し、終了時に破棄。汎用注文APIには要約のみ露出。
   なお自ホスト GPU の Docker/k8s 割当は引き続き実機が必要（🟡）。
7. 課金ティア: ✅ **Spot（中断許容）ティア実装済**（`src/marketplace/spot-tier.js`。出品側の
   オプトイン + 割引、猶予窓つき中断 `POST /orders/:id/preempt`、最低課金を効かせない従量按分
   での精算、注文履歴から導出する中断率の開示。Vast.ai interruptible / Bamboo arXiv:2204.12013）
8. 精算: ✅ **従量按分の精算計算実装済**（`src/payments/settlement-calculator.js`。実使用量(heartbeat)＋SLA で payout/refund/fee を分割。最低課金・SLA ペナルティ・整数 sats 保存則。`escrow-service.settle`／`marketplace-service.settleByUsage`）

### F2. 信頼基盤（最優先トリオ）
- **計算検証 Proof-of-Compute**: 🟡→一部✅ `src/verification/work-verifier.js`（純関数）＋
  `src/verification/verification-service.js`（監査要否/consensus/ゼロ負荷で verdict 確定）＋
  `src/db/json/VerificationRepository.js`（永続化）。
  **ゼロ負荷検出は実レンタルへ結線済（2026-08）**: `src/verification/utilization-collector.js` が
  ハートビートの任意フィールド `utilizationPct` を提供者・借り手の**両方**から集め、終了時に
  食い違いを判定して `order.utilizationAudit` に保存する（両者が遊休で一致=zero_load、
  食い違い=disputed、断定しない）。資金は自動で動かさず、レピュテーション反映・監査ログ・
  UI 開示・係争の材料に留める。
  **未**: 再実行監査（別プロバイダへの同一ジョブ再投入）と ZK/TEE 系の検証パイプライン。
- **Lightning エスクロー**: ❌→🟡 `src/payments/escrow-state-machine.js`（FSM）＋ `src/payments/escrow-service.js`（オーケストレーション）＋ `src/db/json/EscrowRepository.js`（永続化）実装済。**LN実機連携・ルート配線は未**。
- **GPU アテステーション**: 🟡 検証の枠組みは実装・配線済（`src/security/gpu-attestation-verifier.js`、出品時に `attestationReport` を任意提出 → 申告スペックとの突き合わせ 8 チェック → `attestation.passed/score` を保存し一覧・詳細・`sort=recommended` が参照）。ただし**実機の署名検証（nvtrust）は未対応**で、現在の検証器は Mock。したがって「検証済み」と称してよいのは*申告の内部整合性*までで、ハードウェアの真正性ではない。

### F3. レピュテーション/インセンティブ
- ステーク/スラッシング/レピュテーション: ✅ `src/reputation/reputation-scorer.js`（算出）＋ `src/reputation/reputation-service.js`（イベント記録）＋ `src/db/json/ReputationRepository.js`（永続化）。**配線済**: 注文完了時の成否記録、ゼロ負荷監査の結果反映、係争の返金裁定での slash、`GET /gpus?sort=recommended` と `POST /marketplace/rank` での参照。

### F4. 運用・可観測性
- Prometheus `/metrics`: ✅ / 監査ログ HMAC: ✅ / **OTel トレース**: ✅（`src/telemetry/instrumentation.js` を
  `src/api/server.js:5` で全 require より先に読み込み済。本書は長らく ❌ と記していたが誤り）/
  **カーボン配置**: 🟡（`src/gpu/carbon-intensity.js`。申告所在地の系統カーボン強度から
  1時間あたり推定排出量を算出し、`GET /gpus` の `carbon` と `?sort=carbon` で公開。
  所在地は自己申告・未検証のため confidence を必ず添え、不明な地域は推測せず順位も末尾に回す。
  マッチング/価格への carbon-aware な重み付けは未）
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
| P2P | — | ⛔削除。価値のやり取り（資金の預かり・接続情報の仲介・係争裁定・レピュテーション）が**すべて運営のサーバ**にある以上、P2P トランスポート層を足しても信頼の分散にはならない。libp2p が ESM 専用で読み込みにすら失敗したまま放置されていたコードごと削除した |
| テスト | `npm test` 完走、コア green | ✅(40スイート/215テスト green, 2 skip=env依存) |
| データ整合性 | 注文/決済/残高のトランザクション | 🟡(JSON。クロスプロセス lost-update は `src/db/json/fileLock.js` で解決済。複数レコードにまたがるトランザクションは未) |

## 6. 不足部分の実装計画（優先順）

1. **エスクロー状態機械**（✅実装済）— hold invoice の held→settle/cancel/dispute を純 FSM 化＋永続化サービス。`work-verifier` の検証結果で解放判断。
2. **ドメイン層＋HTTP 配線は実装済**: `src/marketplace/marketplace-service.js` が全フローを合成し、
   `src/api/routes/marketplace.js`（`/api/v1/marketplace/*`）が HTTP で公開
   （quote/rank ＝ JWT、escrow open/pay/verify/resolve ＝ admin）。supertest で
   open→pay→verify→SETTLED を検証済。
   **actions→LN 操作の変換層も実装済**（`src/payments/action-executor.js` ＋
   `src/payments/ln-adapter.js` の MockLnAdapter）。

   **ただし 2026-08 のコード確認で、この経路はプロバイダに金を届けていなかった**:
   - 本番の呼び出し側（`marketplace/default.js`・`order/index.js`・`order-expiry.js`）は
     すべて `createEscrowService()` を **lnAdapter 無し**で生成しており、actions は実行されない。
   - 仮に実行されても `payout_provider` が使う `escrow.providerInvoice` は
     **コード中のどこからも書き込まれていない**（送金先が存在しない）。
   - 通常の決済経路（`POST /payments/order/:id`）はそもそもエスクローを開かない。
     借り手が invoice を払うと sats は運営ノードに着金し、**その先の処理が無い**。

   → hold invoice の preimage 公開は「運営が受け取る」ことしか意味せず、プロバイダへの
   支払いは**別建ての送金**になる（FSM の 1 遷移では完結しない）。そこで
   `src/payments/payout-ledger.js`（収益台帳）＋ `src/payments/earnings-sweeper.js`
   （完了注文の自動計上）＋ 出金 API を追加した。**残るは実 LND/CLN アダプタ実装と
   送金の自動実行**（現状は運営が送金して txid を記録する運用）。
3. **永続化エンティティは全て実装済**（Escrow / Provider reputation / Verification record）。将来 Prisma へ移行。
4. GPU アテステーション（nvtrust）、OTel トレース、カーボン配置。
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
- `src/marketplace/auction-engine.js` — 出品の総合順位付け（価格×レピュ×SLA×アテステーション、price-ratio 正規化, 13テスト）。**逆オークションの API は削除済み**: この製品に入札を保存する場所も貸し手が要件を見る画面も無く、旧 `POST /marketplace/auction` は入札内容を呼び出し側が捏造できた。計算は `GET /gpus?sort=recommended` が実データに対して使う（6テスト＋E2E 1）
- `src/payments/action-executor.js` ＋ `src/payments/ln-adapter.js` — escrow actions→LN 操作の変換層＋MockLnAdapter（7テスト）
- `src/payments/payout-ledger.js` ＋ `src/db/json/LedgerRepository.js` — 収益台帳・出金（orderId 冪等の計上、申請中の残高予約、txid 必須の送金記録、**支払い済みキャンセル注文の返金**（係争返金裁定・マッチ期限切れ・借り手キャンセル・プロバイダ拒否は全額返金、active_timeout のみ按分）, 43テスト＋API 22テスト）
- `src/payments/earnings-sweeper.js` — 完了注文の収益自動計上（完了経路ごとのフックではなく状態観測。冪等なので過去分も拾う）
- `src/payments/reconciliation.js` — 帳簿の突き合わせ（保存則・取りこぼしゼロ・出所のない計上ゼロの 3 不変条件と、運営が預かっている債務額, 14テスト＋API 3テスト）
- `src/gpu/listing-defaults.js` — 出品の必須項目を 5 つに絞り、残りを機種から導出（vendor→apiType、既定 arch、参照表の TDP→powerWatt。未知機種は推測せず未設定のまま。導出項目は derivedFields に記録し UI が「推定」と区別, 11テスト＋API 10テスト）
- `tests/api/route-reachability.test.js` — **登録済み全ルートの全数調査**。ルート表そのものを入力にして 5xx がゼロであることを検査する（人が経路を思い出して確認する方式は経路が増えるたびに漏れる）。認証が死んだまま緑にならないよう、通過本数の下限とカナリアで検査の実体を担保する（6テスト）
- `tests/api/no-dead-endpoints.test.js` — 登録済み全ルートを機械的に列挙して実際に叩き、**決して成功しないエンドポイントがゼロ**であることを保証する（5xx と 503 を検出）。個別に気づいて潰す方式では次に増えたときに見逃すため、ルート表から機械的に確かめる
- `src/utils/audit-log.js` — 監査ログ（ハッシュ連鎖＋書き込み失敗の可視化）。チェーン破損・ディスクフル・サイズ上限で**記録が静かに止まらない**: 失敗を状態として保持し `/ready` を 503 に落とし、外部チャネルへ 1 度通知し、繋げられなかったエントリは隔離ファイルへ退避する（7テスト）
- `src/utils/exchange-rate.js` — 為替レート（stale-while-revalidate ＋ 全滅時の冷却期間 ＋ コールド取得の集約。上流障害を「全リクエストが遅い」に増幅させない, 15テスト）
- `src/security/merkle-anchor.js` — 監査ログ Merkle アンカリング（root/包含証明/検証/digest, 6テスト）
- `src/security/audit-anchor.js` — audit.log → Merkle アンカー生成・永続化・包含証明（audit-log 結線、増分 fromIndex/toIndex, 12テスト）
- `src/security/gpu-attestation-verifier.js` — GPU アテステーション検証（申告 vs 計測, 8チェック, Mock 付き, 20テスト）
- `src/security/ots-client.js` — OpenTimestamps カレンダー・クライアント（複数カレンダーへ冗長提出、レシートは不透明保存、既定無効・fail-soft・SSRF ガード経由, 10テスト）
- `src/security/anchor-scheduler.js` — 監査ログの定期増分アンカリング（byte offset 再開、簿記エントリでの空回り防止、切詰め検出, 10テスト）
- `src/marketplace/access-delivery.js` — GPU アクセスの受け渡し（credential の AES-256-GCM 封緘、endpoint スキーム検証、要約と開封の分離, 17テスト＋E2E 2）
- `src/db/json/fileLock.js` — JSON データファイルのクロスプロセス排他（open(O_EXCL) 方式、同期待機、stale 奪取、再入対応。子プロセス実起動の回帰テスト付き, 15テスト）
- `src/gpu/carbon-intensity.js` — 申告所在地に基づく系統カーボン強度・排出量推定（サブリージョン対応、実データ差込口、不明は推測しない, 19テスト）
- `src/verification/utilization-collector.js` — ゼロ負荷課金の検出（両者申告の突き合わせ、リングバッファ、断定しない判定, 15テスト）
- `src/marketplace/spot-tier.js` — Spot（中断許容）ティアのポリシー（割引・猶予窓・最低課金を効かせない中断精算・中断率の導出, 18テスト）
- `src/gpu/perf-score.js` — 機種横断の正規化性能スコア／価格対性能（DLPerf 風。参照表照合・電力由来の TFLOPS 上限クランプ・未検証型番の上限・算出不能は null、feature-pricer への特徴量変換つき, 27テスト）
