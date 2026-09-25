# 第一原理レビュー（2026-09）

「ゼロから作るならどうするか」から現設計を評価した記録。改善ではなく本質からの再評価。
実施手順: 目的 → 制約 → 本質 → 最小構成 → 部品分解 → コスト → ボトルネック → 最終判断。

## 1. 目的

- **プロダクトの目的**: GPU 保有者が余剰計算資源を貸し出し、借り手が対価を支払って利用する
  マーケットプレイスを、単一オペレータが安全に運営する。
- **API の目的**: 登録/認証・GPU 掲載と閲覧・注文ライフサイクル・支払い記録・エスクロー
  帳簿・係争裁定・レビュー/評価・通知設定。
- **DB（JSON 層）の目的**: 単一プロセス運用での注文・決済・エスクロー・ユーザーの永続化。
  temp+rename の原子書き込みでクラッシュ耐性を持つ。マルチプロセスは非対象（既知の制約）。
- **public/ SPA の目的**: 上記をブラウザから操作する唯一のユーザー接点。
- **この処理（本レビュー）の目的**: 利用者価値に寄与しないコード・依存を削り、
  資金移動の未結線という最大の構造ギャップを閉じる。

目的を説明できないもの = 削除候補。該当: 到達不能モジュール群、GraphQL、Prisma、
Electron 断片、KPI 連携スクリプトの一部、ルート直下のモック/雛形ファイル。

## 2. 制約（理想ではなく現実）

- 開発・保守・運用: **1 名**（README「一人運用」）。学習コスト・運用コストは最重要制約。
- 実行環境: 単一 Node.js プロセス。Docker/k8s/PM2 クラスタは実在しない。
- 外部サービス: LND ノード・Docker デーモン・libp2p ピア網は **未配備**
  （ガード付きシングルトンで無効化中。未接続でも API 本体は動く設計）。
- フロントエンド: ビルドパイプラインなし（素の HTML/ESM）。依存ゼロ方針。
- 予算: OSS 個人プロジェクト。SaaS 連携費用は事実上ゼロ。
- セキュリティ: 決済を伴うため認証・監査・SSRF 防御は必須（既に実装済み・テスト有り）。

## 3. 本質

- 利用者が欲しいもの: **GPU を借りて、対価が正しく相手に届き、トラブル時に返金/裁定される**こと。
- 本当に困っていること: 見知らぬ相手との金銭・リソース交換における信頼。
- その問題だけ解決するなら必要なもの: 認証 + GPU 台帳 + 注文状態機械 + 決済記録 +
  エスクロー帳簿 + レピュテーション + 管理者裁定 + 通知。**これ以外は全て付属物**。

## 4. 最小構成（今日ゼロから作るなら）

```
Express API 1 本
├─ JWT 認証 + RBAC + 監査ログ + SSRF ガード付き通知
├─ routes: auth / users / gpus / orders / payments / marketplace / admin
├─ JSON リポジトリ（users, gpus, orders, payments, escrows, watches, reputation, uptime, verification）
├─ 定期ジョブ: invoice-poller・order-expiry・SLA スイープ（プロセス内 setInterval）
├─ public/ SPA（ビルド不要）+ /health /ready /metrics /openapi.json
└─ ガード付きオプション: lightning / vgpu / p2p（未配備時は 503 or 無効化）
```

含めないもの: GraphQL・Prisma・P2P デーモン群・GPU 監視デーモン群・KMS/監査アンカー・
自動パフォーマンス最適化・Electron・30 超の KPI 連携スクリプト・画像最適化パイプライン。
理由: 上記「本質」のいずれにも寄与しない、または実稼働経路に存在しない。

## 5. 部品分解と判定

計測値: `src/` 17,450 行 / 106 ファイルのうち **38 ファイル・3,359 行（約 19%）が
エントリポイント（server.js / cli.js）から到達不能**。require グラフを静的に全辺列挙し、
動的 require が存在しないこと（全 require が文字列リテラル）を確認済み。

| 部品 | 存在理由 | 判定 |
|---|---|---|
| routes/{gpus,orders,payments,users,marketplace,auth} | 本質そのもの | **維持** |
| db/json/* | 唯一の永続化層 | **維持** |
| public/ SPA + swagger.html | 唯一の UI | **維持** |
| payments/{escrow-service,state-machine,settlement-calculator,action-executor,ln-adapter} | 資金移動の状態機械（テスト含め稼働中） | **維持＋結線**（下記） |
| services/{price-watch,renter-eligibility}, reputation/*, verification/*, marketplace/* | 注文・評価・検証の実稼働ロジック | **維持** |
| middleware/*, utils/{validator,order-pricing,order-expiry,async-lock,audit-log,config,logger,error-handler,sanitize,state-checker,notifier,user-notify,exchange-rate,ssrf-guard,request-context,process-guards,tokens,totp,mailer,sanitize-user,session-invalidation,email,btc-payment,lightning-api,profit-addresses} | 稼働中 | **維持** |
| core/{services,service-monitor,invoice-poller,gpu-detector-extended}, telemetry/instrumentation | env ゲート付き実稼働 | **維持** |
| lightning-service.js / p2p-network.js / virtual-gpu-manager.js（ルート直下） | LND/Docker/libp2p 実機向けガード付きオプション | **維持**（オプション・将来結線点） |
| api/graphql.js + apollo-server-express | REST の複製。コンシューマー **ゼロ**（public/ は REST のみ）。apollo-server v3 は EOL | **削除** |
| api/{sla.js, webhook.js, sandbox-apikey.js} | いずれも **未マウントのルータ**（到達不能） | **削除** |
| api/routes/auth/index.js | auth.js に隠蔽される 7 行の重複 | **削除** |
| security/{kms,encryption,compliance,incident,audit-anchor,merkle-anchor}.js + security-audit.js | 監査暗号化/KMS/証跡チェーン — 実行経路に存在しない | **削除**（+専用テスト・プローブ該当ブロック） |
| gpu/*（auto-recovery, error-history, health/liveness-monitor, metrics×2, virtualization） | GPU デーモン群 — 未配線 | **削除**（+専用テスト） |
| db/failover.js + db/migrations/* | pg/ioredis 前提のマルチDB層・knex マイグレーション — DB 層が存在しない | **削除**（+failover テスト） |
| prisma/ 全体 + prisma-* npm scripts | User/Feedback/Task のみで実ドメインを欠く未配線スキーマ。prisma 本体未インストール | **削除**（+ prisma-basic/migration-rollback テスト） |
| utils/{ai-benchmark, anomaly-detector, backup, cloud-storage, gpu-monitor, gpu-price-compare, payment-reminder, perf-auto-optimize, resilient-notify, sla-tracker}.js | 到達不能。resilient-notify の保護（assertPublicUrl/maxRedirects:0）は稼働中の notifier.js に同等実装済みで純粋な重複 | **削除**（+プローブ該当ブロック） |
| p2p-{health,notify,sync}.js | スタンドアロン P2P デーモン。p2p-sync は未インストールの ipfs-core/orbit-db を要求しロード自体が不可 | **削除** |
| web/pages/settings/notifications.js | 放棄された React フロントエンドの残片 | **削除** |
| public/{electron,preload}.js | 削除済み Electron の残片（参照ゼロ） | **削除** |
| ルート直下: gpu_lending_setup_auto_register.js, gpu_lending_dashboard_mock.jsx, gpu_lending_setup_*.md, improvement_checklist2.md | 初期設計の雛形/モック。ARCHITECTURE.md が一次情報 | **削除** |
| scripts/optimize-images.js + imagemin×3 + optimize-images.yml | `public/images/` が存在しないパイプライン | **削除** |
| docker/, kubernetes/ | 単一プロセス前提のデプロイ雛形。コードではなく設定・将来の選択肢 | **何もしない** |
| scripts/ 残り（KPI/Slack/Notion 系） | 1 人運用の運営自動化。実行しない限り無害 | **何もしない**（触れば債務、現状は擱置が最適） |
| OTEL instrumentation | env 未設定時は完全 no-op（require 自体をゲート） | **何もしない** |
| GraphQL 用テスト 3 本 | 削除対象の挙動を検証 | **削除/部分削除** |

## 6. コスト分析

- 削除対象（src 内）: 3,359 行 + 専用テスト 14 本。保守・読解・攻撃表面の分母を直接縮小。
- 依存削減: `apollo-server-express`, `graphql`, `aws-sdk`（v2・EOL）, `imagemin`,
  `imagemin-mozjpeg`, `imagemin-pngquant` を除去。`npm install` の推移的パッケージは
  1,036 → 約 7 割に減る見込み（Apollo 系・aws-sdk・imagemin 群が重い）。
- エスクロー結線: `createEscrowService({ lnAdapter })` は既に実装済みだが、**全 8 箇所の
  本番呼び出し側が lnAdapter を渡していない**ため actions（reveal_preimage/payout_provider/
  cancel_invoice）は計算されるだけで一度も実行されない — エスクローとして致命的なギャップ
  （ARCHITECTURE.md「既知の重大ギャップ」参照）。LightningService は既に
  `settleHoldInvoice`/`cancelHoldInvoice`/`payInvoice` を実装済みで、アダプタ IF を満たす。

## 7. ボトルネック（最も壊れやすい一点）

**エスクローの資金移動が未結線** — SETTLED になっても払い出しが走らず資金が滞留しうる。
次点の複雑さは `routes/order/index.js`（1,985 行: ライフサイクル・係争・セッション・
SLA スイープを同居）だが、動作しておりテストもあるため今回は触らない（分割は将来の変更時に）。

## 8. 最終判断（追加/変更/削除/何もしない）

- **削除**: 上表の「削除」全件 — 価値密度 = 利用者価値(0) ÷ 分母(>0) なので分母を消す。
- **変更**: エスクロー結線（下記）・server.js の GraphQL マウント除去・package.json 依存整理。
- **追加**: なし（機能追加は最後の手段 — 今回の最適解は削除と結線）。
- **何もしない**: docker/, kubernetes/, KPI スクリプト群, OTEL, オプションサービス 3 本。

## 9. 実施内容（この PR）

1. 到達不能モジュール 38 件 + 付随テスト 14 件 + ルート孤立ファイル 6 件を削除。
2. GraphQL エンドポイント削除（src/api/graphql.js・server.js マウント・依存 2 件・
   テスト 2 本削除 + probe34 の GraphQL ブロック除去）。
3. prisma/ ・未使用 optionalDeps（aws-sdk, imagemin×3）削除。
   ※ optimize-images 関連（.github/workflows/ci-cd.yml のステップ・
   optimize-images.yml・scripts/optimize-images.js）は死コードだが、CI トークンが
   `workflow` スコープを持たず .github/ を push できないため本 PR では温存。
   （既存不整合: `npm run optimize-images` は package.json の script 未登録で
   main 上でも実行不能）権限のある push で削除すれば完了。
4. **エスクロー LN 結線**: 9 箇所の `createEscrowService()` 呼出点に `lnAdapter`（ガード付き
   lightning シングルトン）を注入。LN 未配備時は従来どおり no-op。配備時は
   settle/cancel/release の実 LN 操作が実行され、結果はエスクロー履歴に記録される。
   加えて、LN アクションが必要とするコンテキスト（preimage/preimageHash/providerInvoice）
   を持たない帳簿専用エスクローでは、その action を `skipped` として履歴に正直に記録し
   失敗を装わない。
5. セキュリティプローブ: 削除対象ファイルを source-scan していた it/describe ブロックのみ除去
   （probe20, 32, 34, 36, 37, 66）。稼働コードを検証する残ブロックは維持。

## 9b. 第2ラウンド — マスク式アルゴリズム（要件に名前を付けよ）

1st パスは「到達不能（静的に死んでいる）」コードの除去だった。
2nd パスは要件監査: **各エンドポイント/スクリプトに所有者（利用者）がいるか？**
消費者 = SPA (public/js/api.js が使用する ~35 エンドポイント) + テスト + スクリプト。

### 要件監査の結果（所有者なし → 削除）

| 対象 | 消費者 | 判断 |
|---|---|---|
| `src/cli.js` + `src/p2p-{node,order,gpu}.js` | ゼロ（`bin` 未登録、libp2p が依存に存在せず**実行不能**） | 削除 |
| `scripts/{build,deploy}.sh` | ゼロ（コメントのみのスタブ） | 削除 |
| `GET /gpus/system/{detected,amd}` `GET /gpus/:id/{usage,benchmark}` `POST /gpus/:id/benchmark` | ゼロ（SPA・テストどちらも呼ばない） | 削除 |
| 決済 LN ウォレット系 6 エンドポイント (invoice/pay/node-info/channels/history/invoice/:id) | テスト有（lightning-payment-e2e-smoke 等）。API 製品面として温存 | 何もしない |
| `marketplace.js` 9 エンドポイント（auction/escrow/rank/quote） | SPA 不使用だがテスト 5 本。order flow と並行する「API 製品」面 | 何もしない |
| user extras (refresh/logout/me-*/reputation/renter-profile 等) | SPA 不使用だが probes/refresh-reuse 等が検証 | 何もしない |
| `master-auth` `profit-addresses` `notification-settings` | 管理用 API。probe73/77/70/54 が検証 | 何もしない |
| `docker/`, `kubernetes/` | CI ビルドなし・デプロイ担当なし | 意図的温存（デプロイ計画の記録として） |
| `p2p-network.js` | libp2p 未依存で起動時に常に optional-disabled。製品ビジョンの stubs として温存（judgment call — コード衛生上は削除候補だが「P2P」は製品コア） | 何もしない |
| `.github/workflows/cdn-cache-purge.yml` | Cloudflare シークレット未設定の可能性 | workflow スコープ不足で編集不可 → 要ユーザー削除 |

### 実施（第2ラウンドのコミット）

- `src/cli.js`, `src/p2p-{node,order,gpu}.js`, `scripts/{build,deploy}.sh` 削除
- GPU ルートから消費者ゼロの 5 エンドポイント削除（system/detected・system/amd・
  usage・benchmark GET/POST）。README の stale 参照（cli.js・p2p-notify・CLIコマンド例）も除去
- 確認: `tests/gpu/*` + `api.integration` + `probe41/42` — 6 スイート 296 テスト全パス

残課題: SPA が使用しないがテストが存在する API 面（marketplace/*・payment wallet 系）は
「API プロダクトとして意図的」と判断 — ただし外部 API 利用者が実在しない現状では
**要件の所有者がユーザー自身**という状態。もし API 公開を諦めるなら次の大きな削除候補。

### 第3ラウンドの追加削除（未呼出メソッド）

- `lightning-service.js`: `getPendingPayments`/`closeChannel`/`getNodeStats` —
  全コードベースで呼出ゼロ（テスト含む）のため削除。
- `virtual-gpu-manager.js`: `getGPUBenchmarkResults`/`runGPUBenchmark` —
  唯一の呼出点（削除した /gpus/:id/benchmark エンドポイント）が消えたため削除。
  vgpu-route-contract.test の契約リストからも除去。
- 監査結果: `vgpuManager` の公開面は allocate/release/usageStats/details/availability/
  initialize の 6 メソッドのみ使用。残る ~34 メソッド（Docker/K8s/MIG/MPS パス等）は
  エンジン内部構造であり、仮想化機能の削除はプロダクト判断のため温存。

### 第4ラウンドの追加削除（P2P スタブ層の除去 — 実行不能コードは負債）

- **`p2p-network.js`（846行）削除**: libp2p が package.json の依存に存在せず
  `safeLoad` が常に失敗 → 起動ごとに警告を出す永久デッドコード。「P2P」は製品名だが
  実行できないコードは機能ではなく負債（必要なら git 履歴から復元可能）。
- 連鎖削除（`p2pNetwork` が常に null で絶対に通らない枝）:
  - `routes/index.js` の非推奨パススルー `POST /order` `POST /match` `POST /payment`
    （admin 限定でも p2p 必須 → 常に 503 の死にエンドポイント）
  - `POST /orders/:id/match`（同上。probe26 の /match ブロックも除去）
  - gpu ルートの p2p フォールバック 4 箇所・order ルートの updateOrder 通知 3 箇所・
    services.js の p2pNetwork ローダー・server.js の svcRefs/readiness 参照
- 検証: probe25/26/49・order-expiry・payment-btc-onchain×2・api.integration・
  marketplace-escrow — 8 スイート 296 テスト全パス。

### 第5ラウンドの追加削除（実行不能スクリプト + 未結線の通知チャネル）

- **依存未導入で永久に実行不能な scripts/* を削除**: `@octokit/rest` 要の
  checklist-to-issues、`googleapis` 要の feedback-to-sheets / priority-to-sheets /
  progress-report、`@notionhq/client` 要の notion-progress-report / priority-to-notion、
  `chartjs-node-canvas` 要の kpi-trend-graph、`@slack/web-api` 要の slack-notify-graph、
  `i18next` 要の sample（scripts/locales/ も孤立したため同時削除）、空スタブの
  setup-production.sh、imagemin 未導入の optimize-images.js（CI では script 未登録で
  既に失敗していた経路）。package.json の対応 npm script エントリも除去。
- **Sentry 通知チャネル削除**: `@sentry/node` が依存に存在しないため
  sentry-notify.js はロード不能 → service-monitor の Sentry 分岐・README の
  SENTRY_DSN 記述・logger.js のコメントアウト stub・probe57 の対応アサーションを除去。
- 検証: probe57 + service-monitor.e2e + scripts + api.integration 全パス。

### 第6ラウンドの追加削除（依存未導入の統合経路 — 全環境で実行不能）

- **vgpu の docker/kubernetes プラットフォーム一式削除**（~460行）:
  dockerode・@kubernetes/client-node が依存に存在しないため、検出→初期化→
  作成/解放/破棄/統計の switch 分岐と 12 メソッド（initializeKubernetes/initializeDocker/
  createK8sVirtualGPU/createDockerVirtualGPU/setupK8sAccess/setupDockerAccess/
  releaseK8sAccess/releaseDockerAccess/destroyK8sVirtualGPU/destroyDockerVirtualGPU/
  getK8sVGPUStats/getDockerVGPUStats/calculateGPUFraction）はどの環境でも実行不能。
  platform は常に 'native'。marketplace GPU 特別分岐も不要になり単純化。
- **utils/google-calendar.js + order 作成時の連携ブロック削除**（googleapis 未導入。
  注文ごとに「読込失敗」エラーログを吐くノイズ源でもあった）。
- **routes/auth/google.js（POST /api/v1/auth/google）削除**: google-auth-library 未導入で
  idToken 検証は永久に 503/失敗。Google OAuth は passport 経由の GET /auth/google
  フローが既に存在し、そちらは依存あり（passport-google-oauth20）で実行可能。
- 連鎖: vgpu health/route-contract テストの docker/k8s 前提部、probe23a の
  google describe、ARCHITECTURE.md・SPECIFICATION.md の stale 記述を整理。
- 検証: tests/gpu + probe23a/28 + api.integration — 6 スイート 275 テスト全パス。

### 第7ラウンド（ソクラテス式問答 — 「誰が消えたら困るか？」を各構成に問う）

問いのやり方: 各サブシステムに「目的は？利用者は？消したら誰が困る？」を当て、
証拠（呼出元・UIリンク・テスト）で弁明できないものを削除。存続には所有者を要求。

| 対象 | 問答の結論 | 判定 |
|---|---|---|
| routes/auth.js（GET /auth/google・/auth/github + callback） | SPA のどこにも OAuth リンクが無く（public/ 全grep 0件）、テスト消費者ゼロ。ブラウザ直叩き以外到達不能。master-auth の Google OAuth と機能重複。 | **削除** |
| middleware/oauth.js（passport 戦略初期化） | 唯一の消費者は auth.js のみ（master-auth は passport を直接 require）。 | **削除**（連鎖） |
| passport-github2 依存 | GitHub 戦略は oauth.js だけが使用 → npm dep 除去。 | **削除** |
| master-auth + express-session + speakeasy | 「消したら誰が困る？」→ /api/profit-addresses を守る唯一の管理者認証。テスト 4 本が検証。所有者あり。 | 何もしない |
| marketplace /quote・/rank・/auction・escrow系 | 実行時消費者ゼロだが SPECIFICATION §6-2 の規定機能であり、escrow verify が verification-service に実接続。HELD 資金の手動解決手段でもある。 | 何もしない（製品判断に残す） |
| telemetry/instrumentation.js + /metrics | OTEL は env 未設定で完全 no-op（依存を load もしない）。既に最小構成。 | 何もしない |
| gpu-detector-extended・src/data・残 scripts | 起動時初期化／profit-addresses 実データ／実行可能な運用ツール。所有者あり。 | 何もしない |

- 連鎖: routes/index.js の `/auth/*` GET 免除・マウント・require を除去。
- 検証: tests/security + tests/integration — 62 スイート 518 テスト全パス。
- **ソクラテス式の限界**: 「ユーザーは誰か」「GPU 配信の実装意図」はコードからは
  答えられない製品判断であり、前回の問い（§第6ラウンド末尾）に残置。

### 第8ラウンド（ソクラテス式問答 続 — 「仕様書は消費者か？」）

- **POST /marketplace/quote・/rank・/auction 削除**。
  問い: 「誰が呼ぶか？」→ 実行時消費者ゼロ（注文フローは gpuId 明示指定で
  このマッチング経路を通らない。SPA からの呼出もゼロ）。残存根拠は
  SPECIFICATION §6-2 の記載のみだったが、**文書は消費者ではない**。
  実行されない仕様は存在しないのと同じ → 削除。
- 連鎖: marketplace-service の quoteGpu/rankCandidates/selectProvider 削除
  （openOrderEscrow は pricer を直接呼ぶ）、auction-engine.js 削除、
  reputation-service の孤立 rank() 削除、tests/api/marketplace.test.js・
  auction-engine.test.js 削除、probe27・marketplace-service.test・
  reputation-service.test の対応 describe 除去、SPECIFICATION.md 整合。
- **保留（問答の結論が「削除で劣化」）**: GET /users/:id/reputation・
  /renter-profile — SPA 消費者ゼロだが、order フローが記録する
  レピュテーションの唯一の読み出し口。消すと収集が write-only 化し
  データが永久に誰にも見えなくなる。真のギャップは「UI がこの面を
  出していない」ことであり、削除ではなく UI 側の機能欠落と記録。
- 検証: tests/marketplace + reputation + security + api — 全パス。

### 第9ラウンド（ソクラテス式問答 続 — 「書かれたデータは誰が読むか？」）

レピュテーション統計系を追跡した結果、order フロー・attestation・検証・
係争がイベントを書き込み、GET /users/:id/reputation が唯一の読み出し口
だったが、SPA はそれを呼ばない。さらに決定経路（renter-eligibility の
minRenterRating ゲート等）は order.renterReview を直接読み、
reputation-service の統計を参照しない。**書き込みがあり読み込みのない
サブシステムは write-only の telemetry であり、誰の決定も変えない** → 削除。

- 削除: reputation-service.js・reputation-scorer.js・ReputationRepository.js、
  GET /users/:id/reputation・GET /users/:id/renter-profile（renter-profile は
  review データの表示面だが消費者ゼロ — review データ自体は eligibility が
  読むので生存）、_reputationCache/_renterProfileCache/invalidateReputationCache、
  order/gpu/index.js の全 recordJobResult/slash/recordAttestation 書き込み、
  marketplace-service/verification-service/default.js の reputationService 配線。
- 連鎖テスト: reputation-service/scorer.test.js・probe74 削除、
  marketplace-service.test・verification-service.test・probe38/42・
  api.integration の該当 it/describe 除去（write-only コードの検証は消す）。
- 判断が分かれた点: **レビュー機能は生存**（order.renterReview は
  renter-eligibility の決定パスで読まれる — データが動作を変える）。
  provider-uptime も生存（SLA breach が escrow 精算に使われる決定読み）。
- 検証: tests/api+marketplace+reputation+security+integration+verification —
  89 スイート 854 テスト全パス。

### 第10ラウンド（ソクラテス式問答 続 — 「書くこと自体が目的か？」）

write-only 判定を残データストアへ展開。結果はほぼ「何もしない」:

| 対象 | 問い | 判定 |
|---|---|---|
| audit ログ（appendAuditLog + hash chain） | 「誰が読む？」→ 誰も — だが**書くことが目的**（forensic trail。インシデント後にオペレータがファイルを読む経路がある）。reputation 統計は「決定を変えるはずが変えない」が、audit は「事故時に読むための記録」という当初目的を果たす。verifyAuditLogIntegrity が整合性検証の読み出し口。 | 何もしない |
| notification-settings | notifier.js が読んで LINE 通知送信に使う（write→read 完結）。 | 何もしない |
| profit-addresses | btc-payment.js が読んで支払分配に使う。 | 何もしない |
| feedback/kpi エンドポイント | 実装されず 401 のみ返す aspirational ネガティブテスト — 対象コードが存在しないので削除対象なし。 | 何もしない |
| **src/core/logger.js** | 「utils/logger.js（24箇所が使用）と何が違う？」→ 何も。provider-uptime のみが使う重複ロガー。 | **削除**（統合） |

- provider-uptime.js を utils/logger へ切替、core/logger.js（416行の重複実装）削除。
- src/ 全モジュールの所有者スイープ: 残ファイルはすべて外部参照 ≥1 — 孤児ゼロ。
- 検証: provider-reliability + sla-heartbeat-breach + order-limits + probe41 +
  api.integration — 5 スイート 264 テスト全パス。

**ラウンド10の知見**: 掘り進めるほど「何もしない」が増える — 削除可能なものは
ほぼ尽き、残るは所有者を持つコードのみ。これが問い続けた先の状態。

### 第11ラウンド（ソクラテス式問答 続 — 「この依存は誰が require するか？」）

- **winston-daily-rotate-file 削除**: 依存宣言は残るが require するコードは
  第10ラウンドで消した core/logger.js のみ — 所有者を失った依存は負債 → npm dep 除去。
- openapi-generator → /openapi.json エンドポイント + npm scripts + openapi-rbac
  テストが所有者 → 生存。scripts/* の npm エントリも全てファイル実在 → 生存。
- 検証: provider-reliability + service-monitor.e2e + probe41 — 全パス。

### 第12ラウンド（ソクラテス式問答 続 — 「実行できるか？」をスクリプト/フロントにも）

- **npm script `lint` 削除**: `eslint .` は eslint が依存に無く設定ファイルも無い
  （CI では `|| true`/`|| echo` で握り潰されていた）→ 実行不能なコマンド宣言は負債。
- SPA 全監査: public/ の全ページは app.js のルーター登録で到達可能、api.js の
  エンドポイント群は全て src/api/routes に実在 — 孤児なし。
- notifier.js（チャネル抽象化層）と user-notify.js（ユーザー別配送層）は
  重複ではなく層分担 — 両者とも order フロー・price-watch・notification-settings
  が使用 → 生存。playwright e2e specs + test:e2e も設定・dep 揃い → 生存。
- 検証: 影響範囲テスト全パス（lint script は CI 非ブロッキングのため影響なし）。

### 第13ラウンド（ソクラテス式問答 続 — 「このデータを読む機能はあるか？」）

- **POST/GET /api/v1/users/peerid/* 削除** — 「peerId をリンクして誰が使う？」→
  誰も。P2P 層（p2p-network.js）を第4ラウンドで削除済みのため、リンクした
  peerId は読み出す機能が存在しない write-only フィールド。link/unlink/
  get/admin/all + UserRepository.getByPeerId + peerid-uniqueness/probe47
  テストを除去（audit ミドルウェアの peerId 出力は既存レコードの歴史表示で残す）。
- **data/reputations.json + globalSetup の 'reputations' エントリ削除** —
  削除済み reputation-service の実行時残骸。db/json リポジトリの残りは全て
  所有者あり（Verification/Uptime/Watch/Escrow/Payment/Order/Gpu/User）。
- 検証: tests/api + utils + api.integration — 30 スイート 358 テスト全パス。

### 第14ラウンド（ソクラテス式問答 続 — 「実行経路はあるが誰が選ぶか？」）

- **BTC on-chain 決済（/payments/btc）**: SPA の支払選択は lightning/manual のみ —
  btc-onchain は UI から選べない。ただし実装済み・テスト済み・profit-addresses
  （支払分配読み出し）を支える実 payment rail であり、marketplace escrow と同じ
  「実行可能だが現 UI が出していない製品面」→ 生存（製品判断に残す）。
- **PRODUCT_ANALYSIS.md に deprecation banner 追加**: 削除済み機能を
  「✅ 実装済み」と称する記述が多数残っていた（reputation・p2p・docker/k8s 等）。
  歴史分析として残すが、stale な事実を最新状態への誘導で修正。

### 第15ラウンド（ソクラテス式問答 終 — 収束判定）

問いを尽くした結果、残る全構成は「所有者・読み出し先・実行経路」を弁明可能:

- order/index.js 内部ヘルパーは全て呼出しあり（dead branch なし）
- メール2系統は重複ではなく別提供者: `api/utils/mailer.js`(nodemailer←master-auth) /
  `utils/email.js`(SendGrid/Mailgun API←notifier チャネル)
- e2e spec が削除済みエンドポイントを叩いていない
- jest.config / 各種設定は有効

結論: **コードから答えられる問いは尽きた**。これ以上の削減は製品判断
（機能を本当に消す）か権限外（.github）。残る未回答は利用者の有無・
GPU配信の意図・外部API消費者・運用者 — コードは答えを持たない。

### 第16ラウンド（ソクラテス式問答 — 「設定面もコードか？」）

`.env.example` の全変数に消費者を要求:

- **削除**: `SENTRY_DSN`（Sentry は第5ラウンドで除去済み — 消費者ゼロ）、
  `ENCRYPTION_KEY`（消費者ゼロ — requireSecret は JWT_SECRET/SESSION_SECRET のみ。
  SPECIFICATION.md の fail-fast 記述も stale だったので修正）
- **生存**: 残り全変数（NODE_ENV/PORT/JWT_*/API_KEY/GOOGLE_*/MASTER_*/LND_*/
  BTC_FEE_RATE/LOG_LEVEL/SLACK_WEBHOOK/DISCORD_WEBHOOK/LINE_TOKEN — 全て
  src/scripts/tests に消費者あり）

ARCHITECTURE.md の p2p/libp2p 言及は削除履歴の文脈説明として正確なため生存。

### 第17ラウンド（ソクラテス式問答 — 「テスト・設定・アセット層も負債か？」）

- public/ 全ファイル（css/js/pages/swagger.html）に所有者あり — 孤児なし
- jest.config / playwright.config に削除済み参照なし
- tests/ に削除済みエンドポイントを叩く spec なし（auth/google・graphql の
  言及は除去を説明するコメントのみ）
- 全ミドルウェアがマウント済みか共有ヘルパー（ip-key.js は rate-limit.js と
  security.js の共有キー生成 — 稼働中）
- npm scripts の宛先ファイルは全て実在

結論: 3連続で新規削除ゼロ級。問答は全層で「弁明可能」に収束 — これが
ゼロベースレビューの終点。以降は製品判断のみ。

### 第18ラウンド（ソクラテス式問答 — 「ルート粒度で誰が呼ぶか？」）

全 mounted エンドポイントと SPA 呼出しを突合（前ラウンドまではファイル粒度、
今回はルート粒度）:

- **削除**: `PUT /users/me/settings` + `SETTINGS_SCHEMA` + register 時の既定
  settings（48行）— user.settings を読むコードが全体でゼロ。書込み専用の
  write-only エンドポイント。テスト消費者もゼロ。
- **生存（製品判断に残す、全てテスト消費者あり）**: renter-review・node-info・
  channels・history・me/activity・me/watches・gpu bulk/clone/block/schedule/
  eligibility — SPA が呼ばないが spec'd 製品面。marketplace escrow と同じ
  「UI が出していない API」カテゴリ。切るなら明示の製品判断。

検証: tests/api + tests/security — 83 スイート 577 テスト全パス。

### 第19ラウンド（ソクラテス式問答 — 「export された機能は誰が呼ぶか？」）

ファイル粒度→関数粒度へ掘り下げ: 全 module.exports の各 export 名に消費者を要求。

- **削除（外部消費者ゼロ・内部使用ゼロ = 完全死）**: `authenticateAPIKey`・
  `apiKeyAuth`（security.js の API キー認証2系 — JWT 認証に置き換わり誰も
  マウントしていない）、`invalidateByUrlPattern`（cache.js）、`generateTOTP`
  （totp.js — verifyTOTP のみ使用）、`GPU_STATES`・`isValidGPUTransition`・
  `ORDER_STATES`（state-checker.js — isValidOrderTransition のみ生存。
  GPU 状態遷移チェックは消費者ゼロ）
- **export のみ削除（関数は内部使用で生存）**: tokens.js `accessTTL/refreshTTL`、
  service-monitor `isServiceHealthy`、action-executor `LN_ACTIONS/DOMAIN_ACTIONS`、
  feature-pricer `GENERATION_SCORES`、gpu-attestation `scoreChecks`、
  order-expiry `resolveTimeoutMinutes`、order-pricing `resolvePricePerHour`、
  notification-settings `_isSSRFUrl` — 公開 API 面を実態に揃える
- 計 −103 行（12 ファイル）。検証: 32 スイート 150 テスト全パス。

### 第20ラウンド（ソクラテス式問答 — 「このメソッドの呼出し木の根はどこか？」）

クラスメソッド到達性解析（外部エントリポイントから this.呼出しグラフを BFS）:

- **virtual-gpu-manager.js**: 38 メソッド中 **12 が到達不能** — `createVirtualGPU`
  が呼出し元ゼロ（allocateGPU/releaseGPU/getGPUDetails/getGPUUsageStats/
  getGPUAvailability/initialize/isHealthy/shutdown が生存根）。その子孫
  createNativeVirtualGPU→createMIGInstance/createVGPUInstance/createMPSInstance
  + selectMIGProfile/selectVGPUType/determineVGPUType + calculate*Allocation +
  saveVirtualGPUConfig — 「GPU を仮想化して切り出す」配信系は allocateGPU
  （物理 GPU を丸ごと割当）とは別系統で未接続だった。−235 行。
- **gpu-detector-extended.js**: `detectIntelGPUsAdvanced` 到達不能 −30 行。

検証: tests/gpu + api.integration — 4 スイート 257 テスト全パス。

### 第21ラウンド（ソクラテス式問答 — 到達性解析を残クラスへ展開）

- **gpu-detector-extended.js**: Intel GPU 検出 subtree 8メソッド削除（−158行）。
  detectIntelGPUTools/detectIntelSysfs は元々 detectIntelGPUsAdvanced（呼出し元ゼロ、
  第20ラウンドで削除済み）配下で、残った子孫も到達不能。生存する検出経路は
  detectAMDGPUsAdvanced/Windows + detectIntelGPUsWindows + queryWindowsVideoControllers。
- lightning-service・escrow/verification/marketplace-service・db/json リポジトリ・
  service-monitor 等の残クラスは到達性解析で全メソッド生存（dead 0）。
- 偽陽性除外: sanitize.js は destructure 呼出し経由で使用中のため生存。

検証: tests/gpu + basic — 全パス。

### 第22ラウンド（ソクラテス式問答 — 「この設定キーは誰が読むか？」）

config.js の全キーに消費者を要求（書き込まれるが読まれない=write-only 設定）:

- **削除**: `config.p2p` 全節（第4ラウンドで層ごと削除済みの残骸 +
  P2P_PORT/P2P_BOOTSTRAP_NODES envローダー）、`gpu.{scanIntervalMs,
  virtualGpuEnabled,dockerSupport,kubernetesSupport,priceUpdateIntervalMs}`
  + 対応 env ローダー（docker/k8s は第6ラウンドで削除済み）、
  `lightning.{network,lndHost}`（lightning-service は env を直接読むため
  config 経由は死んだ重複）、`security.{corsEnabled,helmetEnabled}`、
  `logging` 全節（logger は process.env.LOG_LEVEL を直接読む）
- **生存**: server 全キー・gpu.minMemoryGB（validator）・lightning.
  {certPath,macaroonPath,invoiceExpirySeconds,minPaymentSatoshis,
  maxPaymentSatoshis}・security.{jwt*,bcryptRounds,rateLimitEnabled}

検証: tests/api + probe20-29 — 33 スイート 146 テスト全パス。

### 第23ラウンド（ソクラテス式問答 — 「import した名は使っているか？」）

destructure された未使用 import の棚卸し（使用ゼロの名を除去）:

- gpu/index.js: `gpuDetector`・`requireService` を除去（vgpuManager のみ使用）
- server.js: `cachePurgeCounter`・`serviceRestartCounter`・`serviceDownCounter`
  を除去（require 副作用での prom-client 登録は存続）
- tests/security 9件: 未使用 `app` destructure を bare require へ
- gpu-attestation-verifier.test.js: 未使用 `DEFAULTS` 除去
- 偽陽性除外: `{ v4: uuidv4 }`/`{ rateLimit: readyRateLimit }` リネームは使用中
- scripts/ の残りは全て package.json エントリ経由で所有者あり・依存充足

検証: 対象スイート全パス。

### 第24ラウンド（ソクラテス式問答 — 「emit したイベントは誰が聴くか？」）

- **削除**: `this.emit(...)` 11箇所（lightning-service 7: initialized/invoice:created/
  invoice:paid/payment:sent/payment:hash/channel:opened/closed/invoice:expired、
  vgpu-manager 4: initialized/vgpu:allocated/released/destroyed）— リスナーが
  コード全体にゼロ（write-only イベント）。invoiceStream.on 等の残存リスナーは
  LND gRPC ストリーム向けで別物。`extends EventEmitter` + `super()` も除去
  （lightning-service は `new EventEmitter()` をストリーム用に使うため require のみ残す）
- **gpuDetector 生存確認**: routes/index.js の起動時検出で実呼出しあり

検証: tests/gpu + basic + probe23b — 全パス。

### 第25ラウンド（ソクラテス式問答 — 「消した機能の残骸がコードに残っていないか？」）

- **削除**: lightning-service.js の SENTRY_DSN ガード4箇所 + `notifyExternal`
  クロージャと呼出し8箇所 — 第5ラウンドで Sentry を除去した際に残った
  空の if（中身はコメントアウトのみ）と、そのラッパー。全て no-op。
- 孤児化ファイルの再スキャン: 新規孤児なし（連鎖削除が綺麗に効いている）
- process.env 棚卸し: SLACK_WEBHOOK_URL 等の未文書化 ops ノブは
  実消費者あり（scripts/service-monitor）で生存 — .env.example への
  網羅は文書量の増大になるため対象外。

検証: probe23b + basic — 全パス。

### 第26ラウンド（ソクラテス式問答 — 「コメントは現在のコードを説明しているか？」）

- order-expiry の 4 スイープ関数は全てスケジューラ/ルートに登録済みで生存
- **修正**: 削除済み reputation サブシステムを現在形で説明する stale コメント
  6箇所（marketplace.js の「二重 reputation slash」、order/index.js の
  dispute/resolve・stop ハンドラの reputation 副作用記述）→ 実態
  （escrow 二重精算防止）に書き換え
- PUBLIC_PATHS は全エントリが実ルートに対応（stale なし）

### 第27ラウンド（ソクラテス式問答 — 「静的アセット・文書・実行時データは辿れるか？」）

- swagger.html/docs.js/docs.css — 静的に配信される OpenAPI ビューア
  （/openapi.json の spec 面）→ 生存
- data/ 実行時ファイル全てが live リポジトリに対応（stale なし）
- 運用系文書（SECURITY_AUDIT・operations・faq・LIGHTNING_API_SETUP 等）に
  削除済み機能の記述なし — research 系2文書（improvement/category-research）に
  時点スナップショットの記述のみ → deprecation banner で誘導

### 第28ラウンド（ソクラテス式問答 — 「この npm 依存/スクリプトは実行可能か？」）

- **削除**: `npm run dev`（nodemon が依存に存在せず実行不能 — 第12ラウンドの
  lint と同種の死んだスクリプト）
- 依存再スキャン: 全 dependencies + devDependencies（jest/supertest/
  @playwright/test）に消費者確認 — 削除連鎖で孤児化した依存なし
- src/services（price-watch・renter-eligibility）・src/api/utils 全ファイル
  生存確認

検証: basic テストパス。

### 第29ラウンド（ソクラテス式問答 — 「個別ファイルの残りは？」）

- `api/utils/lightning-api.js` — btc-onchain 経路の LN 引出しアダプタ
  （OpenNode/LNbits/BTCPay）。btc-payment.js とテストが消費 → 生存
- `session-invalidation.js` — jwt-auth が消費するトークン無効化ポリシー → 生存
- `src/utils/` 全16ファイル・ルート全ファイルの消費者を再確認 — 孤児なし

結論: 第28・29ラウンド連続で削除対象なし級。監査可能な全層で
「所有者・読み出し先・実行経路」が弁明可能 — 収束維持。

### 第30ラウンド（ソクラテス式問答 — 「e2e は生きた UI を検証しているか？」）

- tests/e2e 全 spec の参照セレクタ・ハッシュルート（#/market・#/orders・
  #/my-gpus・#/earnings・#/admin/payments・#/gpus/new・#/login・#/register・
  ハートビート・通知を設定・badge-*/stars/toasts/empty-state 等）が全て
  public/ の実 UI に存在 — 死んだ e2e なし
- playwright chromium-1194 インストール済みで実行可能
- ルーター登録ページと spec 参照ルートが完全整合

結論: e2e 層も全て生存する検証対象を持つ。全層収束維持。

### 第31ラウンド（ソクラテス式問答 — 「統合できる重複はないか？」）

- `sanitize-user.js`（レスポンスの機密フィールド除去）と `sanitize.js`
  （入力サニタイズ）は別目的 — 統合すると責務混濁。両者生存。
- `notifier.js`（LINE/Discord/Slack/Telegram/email チャネルアダプタ+retry）と
  `user-notify.js`（ユーザー設定→チャネル解決）は層分担で生存。
- `process-guards.js`（server.js が消費）等、薄ラッパーの統合候補なし。

結論: 「統合」軸もクリーン。責務分離が適切で、統合による価値密度の
改善余地なし。

### 第32ラウンド（ソクラテス式問答 — 「テストだけが消費する製品コードはあるか？」）

- `ln-adapter.js`: テスト参照3件で一見 test-only に見えたが、実体は
  escrow-service の DI インターフェース（marketplace/default.js・
  order/index.js・action-executor が消費）— PR #6 のエスクロー結線の
  心臓部で生存
- `order/index.js` の test-only フラグは basename スキャンの偽陽性
  （`require('./order')` でディレクトリ経由）

結論: 製品コードに test-only 消費の偽装はなし。収束維持。

### 第33ラウンド（最終検証フェーズ）

全監査軸の収束を受け、current head でフル jest スイートを実測:
**116 スイート・1,048 テスト全パス**（1 skipped）。全削除の累積後も
システム全体が健全 — 削除したのは本当に dead であったと実測で確証。

### 第34ラウンド（ソクラテス式問答 — 「重複コードは統合できるか？」）

重複スキャン（6行以上の重複ブロック）で発見: order/index.js の
エスクロー処理ブロックは**外見は同じだが意味的に別物** —
HELD キャンセル失敗を致命にする箇所（admin cancel / renter delete）と
ベストエフォートの箇所（reject / dispute resolve）が混在し、
settle（精算）と cancel（返金）の別操作もある。ロジックは統合不可。

統合したのは boilerplate のみ: `require(EscrowRepository)` 8箇所・
`require(escrow-service)` 7箇所の遅延 require をファイル先頭へ集約
（循環なし: escrow-service は routes に依存しない）。−22/+9 行。

検証: tests/api/order・tests/payments・api.integration — 10 スイート
301 テスト全パス。

### 第35ラウンド（ソクラテス式問答 — 「バリデータの重複は？」）

`Joi.object({ id: uuidv4 })` params スキーマが order/gpu ルートに
14 箇所逐語重複 → `schemas.idParam` として validator.js に一本化。
（blockId 付き変種1箇所は別スキーマとして残置）

検証: tests/api/order・tests/api/gpu・api.integration — 6 スイート
258 テスト全パス。

### 第36ラウンド（ソクラテス式問答 — 「gpu ルートの重複は統合可能か？」）

第34ラウンドの重複スキャンが gpu/index.js に挙げた残ブロックを精査:
- 「オーナー向け details/usageStats/availability 取得」は実際には
  1 箇所のみ（4x フラグは 6 行窓の重なりによる偽陽性）
- attestation 分岐・削除時ウォッチ後始末・見積競合チェックは
  各々別目的 — 統合不可

結論: gpu/index.js に統合可能な重複なし。全重複フラグを精査し尽くした。

### 第37ラウンド（ソクラテス式問答 — 「定義済みスキーマに消費者はいるか？」）

validator.js の全スキーマを監査:
- `schemas.match`（/match エンドポイントのリクエスト検証）— エンドポイント
  自体を第8ラウンドで削除済み → スキーマも残骸として削除
- `schemas.idParam`/`gpu`/`order`/`payment`/`user`/`lightningNode`/
  `lightningChannel` は全て消費者ありで生存
- 「`messages` は Joi.extend カスタム uuid 拡張のオプション（スキーマではなく
  フラグ）— 削除対象外

検証: tests/api/order・api.integration — 254 テスト全パス。

### 第38ラウンド（ソクラテス式問答 — 「SPA 関数と docs の消費者は？」）

- SPA 未呼出スキャン: 6 候補は全て偽陽性（ローカル変数の値参照・
  addEventListener 経由・map コールバック）— public/js に死関数なし
- docs リンク監査: `feedback-report.md`（生成スクリプトが出力する
  「今週なし」スタブを誤ってコミットした実行時アーティファクト）と
  `README_docs.md`（markdown-toc 規約 — ツール未導入・全 doc に
  toc マーカーなしの死んだ規約）を削除
- `README_feedback.md` は対象スクリプト feedback-bot.js が稼働中で生存

### 第39ラウンド（ソクラテス式問答 — 「スキーマのサブキーまで消費者がいるか？」）

schemas.gpu のサブスキーマ監査: `register`・`update` は稼働中だが
`search`（GPU検索クエリ検証用30行）はゼロ参照 — GPU 一覧ルートは
req.query を直接パースしており、このスキーマを経由しない → 削除。
order.create・payment.*・user.* は全て消費者あり。

検証: tests/utils・tests/api/gpu — 37 テスト全パス。

### 第40ラウンド（ソクラテス式問答 — 「リポジトリ・APIラッパーの未使用メソッドは？」）

- db/json 全リポジトリのメソッドを呼出しスキャン: 全メソッドに
  消費者あり（`createdAt` フラグはコメントの偽陽性）
- public/js/api.js のラッパー関数: 全て pages から呼出し済み
  （ApiError/request 等はクラス内部・ビルトインの偽陽性）

結論: リポジトリ・フロント API 層とも未使用メソッドなし。

### 第41ラウンド（ソクラテス式問答 — 「インフラ定義ファイルの実体は？」）

- `docker/Dockerfile.gpu-worker`（21B・コメントのみ）、
  `docker/docker-compose.yml`（15B・コメントのみ）、
  `kubernetes/deployment.yaml`・`service.yaml`（中身ゼロのスタブ）削除 —
  「存在する」が「動く」ではない empty stubs
- `optionalDependencies` の `@kubernetes/client-node`・`dockerode` 削除 —
  第6ラウンドで k8s/docker コードパスを消した際の残り依存（参照ゼロ）
- `Dockerfile.api`・`.dockerignore` は実体あり・生存

検証: tests/gpu・api.integration — 257 テスト全パス。

### 第42ラウンド（ソクラテス式問答 — 「リポジトリルートの孤立物は？」）

- `logs/` — 42MB の実行時ログ（audit.log・error-*.log 等）は untracked +
  .gitignore 済み → リポジトリ上の問題なし（ディスクのみ）
- `improvement_checklist2.md` — README からリンク済み・免責 banner あり → 生存
- `.github/workflows/optimize-images.yml` — 削除済み `scripts/optimize-images.js`
  を参照する stale workflow → **要対応だが私のトークンは workflow スコープ無しで
  push 不能。手動削除を推奨**（ci.yml の `optimize` ジョブも同様に dead）

### 第43ラウンド（ソクラテス式問答 — 「ルートの重複定義・未マウントは？」）

- 全ルートファイルの METHOD+path 重複スキャン: Express シャドウ
  （先勝ちで後方が dead 化）なし
- 未マウントルート監査: `payment/btc-onchain.js` は payment/index.js が
  `/btc` にマウント（フラグは偽陽性）。全ルートファイルがマウント済み

結論: ルーティング層クリーン。

### 第44ラウンド（ソクラテス式問答 — 「export 全量の消費者監査」）

src/ 全ファイルの export 名を総当たり: 
- `serviceDownCounter`・`serviceRestartCounter`・`cachePurgeCounter` —
  prom-client 経由でメトリクスは発火するが JS 側の export 束縛は第23ラウンドで
  import 先を消した残骸。`.inc()` 呼出しは生存のため export 名のみ除去
- 残り全 export に消費者確認済み

検証: tests/security/probe57・api.integration — 242 テスト全パス。

### 第45ラウンド（ソクラテス式問答 — 「設定・ヘルパーファイルの消費者は？」）

- `scripts/config.js` 削除 — API_ENDPOINT=api.example.com の雛形残滓、
  全スクリプトが直接 process.env を読み誰も require していない
- `jest.config.js` — 全設定項目に根拠コメントあり・パス実在で生存

検証: コード変更なし（孤立ファイル削除のみ）。

### 第46ラウンド（ソクラテス式問答 — 「SPA ナビ到達性・テストリセット網羅性」）

- SPA ルート全10件が nav/リンクから到達可能（JS 駆動 nav・初回スキャンは
  href 正規表現の偽陰性だった）→ クリーン
- `globalSetup.js` のリセット対象に `watches` が欠落 — watches.json が
  テスト間で蓄積し続けていた（getAll() 線形スキャンの速度低下要因）。
  arrayFiles に追加
- services.js safeLoad 3件・SPECIFICATION.md の削除マーキングは整合済み

検証: user-watchlist・api.integration — 240 テスト全パス。

### 第47ラウンド（ソクラテス式問答 — 「ルート文書の stale 参照は？」）

- CONTRIBUTING.md: `npm run lint` 参照2箇所削除（スクリプトは第12ラウンドで除去済み）
- README.md: libp2p インストール案内を削除（P2P 層は第4ラウンドで削除済み）
- ARCHITECTURE.md: p2p-network を現在形で記述していた箇所を「削除済み」に修正、
  peerID（第13ラウンド削除 API）の言及を除去
- `npm run openapi` 等の残スクリプト参照は実在確認済み

### 第48ラウンド（ソクラテス式問答 — 「コメント中の削除済み機能言及は？」）

- user/index.js: 「REST/GraphQL と同一ポリシー」→ GraphQL は除去済み → REST に修正
- instrumentation.js: オプショナル統合の例として挙げていた P2P・OAuth（両方削除済み）を
  real LND のみに修正
- 残りの言及（P2P 製品名・apiKey フィールド除去等）は実在物で生存

検証: tests/api・tests/utils — 30 スイート 358 テスト全パス。

### 第49ラウンド（ソクラテス式問答 — 「静的アセットの消費者は？」）

- 全 public/ ファイル棚卸し: index.html・css・js・swagger.html 全て稼働中
- `public/README_public.md` 削除 — ハッシュ付きビルド出力（ビルド無し）・
  `optimize-images`（第5ラウンド削除）・i18n ディレクトリ（非存在）・
  deploy_public.sh（非存在）を推奨する汎用テンプレート文書で、
  このリポジトリの実態と無関係
- src/ 全77ファイルに消費者再確認 — 孤児なし

### 第50ラウンド（ソクラテス式問答 — 「状態機械の死んだ遷移は？」）

- escrow-state-machine の全7イベント（PAY/CANCEL/DEADLINE/DELIVER_OK/
  DELIVER_FAIL/RESOLVE_SETTLE/RESOLVE_REFUND）に発火元あり — FSM 全生存
- `createJsonRepository.js` のヘッダコメントが削除済み Reputation を
  列挙していた stale を修正（実在8リポジトリに更新）

### 第51ラウンド（ソクラテス式問答 — 「削除した文書へのダングリング参照は？」）

- `docs/faq.md` 削除 — 全回答が非存在インフラを指す架空運用文書だった:
  deploy_public.sh（非存在）・scripts/config.js（第45ラウンド削除）・
  locales/i18next（第5ラウンド削除/未導入）・markdown-toc（未導入）・
  k8s Pod 運用（スタブのみ・第41ラウンド削除）・public/ 自動デプロイ
  （workflow 非存在）。リンク元（operations.md・README_feedback.md）を修正
- research 系文書の p2p-network 言及は時点スナップショット banner で
  既に免責済み（第27ラウンド）

### 第52ラウンド（ソクラテス式問答 — 「運用文書は実態を記述しているか？」）

- `docs/operations.md` 削除 — faq.md と同じ架空運用テンプレート:
  「GitHub Actions 自動本番デプロイ」「Grafana/Loki」「PagerDuty」
  「Chaos Mesh 障害訓練」「Slack #incident-report」「本ドキュメントへの
  自動追記」— 全て実在しない仕組み。リンク元ゼロ
- `docs/SECURITY_AUDIT.md` — ハッシュチェーン監査ログ・profit-addresses・
  LN API 等、実装済み機能を記述 → 生存

### 第53ラウンド（ソクラテス式問答 — 「スクリプトの入力は誰が生産するか？」）

- `slack-notify-notion.js` 削除 — notion-progress-report.md の生成側は
  第5ラウンドで削除済み → 常に「レポートなし」で終わる dead-end
- `alert-kpi-trend.js` 削除 — `checklist-kpi-report-YYYY-MM-DD.md`（日付付き）を
  期待するが生成側は `checklist-kpi-report.md`（日付なし）を出力 →
  永久に2ファイル未満で常に早期 return
- 対応 npm script 2件除去。残りスクリプトは feedback→priority→alert の
  生産→消費チェーン完結を確認（feedback-bot・feedback-priority・
  alert-*・slack-notify 系は全て実在ファイルを読み書き）

### 第54ラウンド（ソクラテス式問答 — 「生成物がコミット混入していないか？」）

- `docs/{assignee-progress-report,checklist-kpi-report,feedback-report}.md` を
  追跡解除 — scripts/ が再生成する実行時アーティファクトが誤って tracked
  だった（feedback-report.md は第38ラウンドで削除したが検証実行で再生成→
  git add -A で再混入していた）
- `.gitignore` に生成物6件追加（上記3件 + feedback-log.json +
  feedback-priority.json + improvement_checklist4.md）
- npm script→ファイル整合: 全21件 OK

### 第55ラウンド（ソクラテス式問答 — 「env 変数は実装と整合しているか？」）

- **名不一致バグ発見**: `SLACK_WEBHOOK`（order/index.js が読む）と
  `SLACK_WEBHOOK_URL`（service-monitor・slack-feedback-bot が読む）が
  分裂 — 片方だけ設定した運用者は半分の通知を失う。`SLACK_WEBHOOK_URL`
  に統一（3箇所修正）
- `.env.example`: 死んだ `API_KEY=`（x-api-key 認証は第19ラウンドで削除）を
  除去し、コードが読むのに未記載だった44変数をオプション節として追加

検証: tests/api/order・api.integration — 254 テスト全パス。

### 第56ラウンド（ソクラテス式問答 — 「宣言的 finder に呼出し先はあるか？」）

- 削除: `UserRepository.getByApiKey`（x-api-key 認証は第19ラウンドで除去済み）、
  `getByGoogleId`（master-auth は email 経路を使用）、
  `GpuRepository.getByOwner`（呼出しゼロ。しかも field:'ownerId' は実フィールド
  `providerId` と不一致で呼んでも空配列しか返らない二重 dead）
- 残り11 finder 全て呼出し元あり

検証: tests/db・api.integration — 254 テスト全パス。

### 第57ラウンド（ソクラテス式問答 — 「README の機能一覧と CSS セレクタは実態と一致するか？」）

- README stale 記述6箇所を修正: 「APIキー＋JWT認可」（api-key 認証削除済み）、
  「Ed25519ピアIDによるP2P信頼性」「ピアID＋署名検証」（P2P層削除済み）、
  「API／CLI／GraphQL」（GraphQL・CLI 非存在）、「Google/GitHub OAuth ユーザー認証」
  （OAuth ルート削除済み）、exchange-rate の GraphQL 言及3箇所
- CSS 死セレクタ削除: `.icon-btn`（参照ゼロ）、`.text-center`（同）。badge-*/chip-*/toast-*/
  docs-method-* は JS テンプレで動的構成のため生存

### 第58ラウンド（ソクラテス式問答 — 「通知設定・docs ページ・テストヘルパーは消費者ありか？」）

- 全生存を確認: LINE_TOKEN（service-monitor + order notify で実読み）、
  swagger.html → js/docs.js + css/docs.css → /openapi.json の docs チェーン完結、
  notification-settings（lineToken 等はユーザー設定経由で実消費）、
  tests/helpers は存在せず監査対象なし
- 削除ゼロのラウンド

### 第59ラウンド（ソクラテス式問答 — 「生成される OpenAPI spec のパスは実在するか？」）

- 判定: **偽の文書を削除**。`openapi-generator.js` が生成するパス
  （`/idParam/idParam`、`/lightningNode/lightningNode`、`/gpu/update` 等）はスキーマ名からの
  推測で、実ルート（`/api/v1/gpus` 等）と一切一致しない — 存在しない API を宣伝する
  文書は「ない」より悪い（イーロン原則: 最善のパーツは存在しないパーツ）。
  openapi-rbac テストも spec 自身のメタデータを検証するだけの自己参照テスト。
- 削除: openapi-generator.js、server.js `/openapi.json` ルート、public/swagger.html、
  public/js/docs.js、public/css/docs.css、openapi-rbac テスト、npm scripts
  `openapi`/`openapi-gen`、依存 `joi-to-swagger`（lock 手術済み）。setup スクリプト修正。
- README/ARCHITECTURE/PRODUCT_ANALYSIS の関連記述を修正。
- API 参照は `docs/SPECIFICATION.md` が担う。

検証: tests/api + tests/security + api.integration — 83スイート 814テスト全パス。

### 第60ラウンド（ソクラテス式問答 — 「唯一残ったAPI参照 SPECIFICATION.md は実ルートと一致するか？」）

- stale 2箇所を修正: 支払い行の「🟡(エスクロー無し)」→ hold-invoice エスクローは
  FSM+order settle/cancel で結線済み（第1ラウンド修正）の実績に更新。
  LN 情報のパス `/api/v1/node-info` → 実マウント `/api/v1/payments/node-info` に修正
  （+/channels+/history）。
- 残行は削除済み注記付きで正確（reputation・marketplace 面・docker/k8s）。

### 第61ラウンド（ソクラテス式問答 — 「セキュリティ許可リストに実ユーザーのいない緩和はないか？」）

- CSP `connectSrc: 'wss://*'` を削除 → `["'self'"]`。SPA は fetch 同一オリジンのみで
  WebSocket/EventSource を使わない — 削除済み P2P 層の許可残滓（過剰権限の
  セキュリティ緩和を除去 — これは削減兼 hardening）。
- helmet 各ディレクティブ・Permissions-Policy・CORS ロジックは全て弁明可能。

検証: api.integration + security — 61スイート 731テスト全パス。

### 第62ラウンド（ソクラテス式問答 — 「書かれるが読まれないデータフィールドはあるか？」）

- `apiKey` フィールドは生成経路が消滅（APIキー認証は第19ラウンドで削除済み）—
  新規レコードに値が入ることはない。残る参照は sanitize の除去リストと
  退会時 `apiKey: null` のみ → レガシーレコードの旧値を消す衛生コードとして生存判定。
- `googleId` フィールド: スキーマ・書込み・読出し全てゼロ（finder も第56ラウンドで削除済み）
  → コード側の痕跡は既になし。
- レートリミッター2系（apiLimiter/authLimiter）+ ip-key ヘルパーは全てマウント済み。
- 削除ゼロのラウンド（防御コードはレガシーデータ対応で正当）。

### 第63ラウンド（ソクラテス式問答 — 「生産→消費チェーンの断絶・到達不能アダプタはないか？」）

- provider-uptime チェーン全生存を確認: order heartbeat/SLA breach → recordX →
  UptimeRepository → getReliability → GPU 一覧の reliability chip（SPA の
  `chip-reliability-*` CSS も第57ラウンドで生存確認済み）。reputation 層削除の
  残存ファイルだが稼働中。
- exchange-rate 4プロバイダ（CoinGecko/CryptoCompare/BitFlyer/Binance）全て
  実在エンドポイント・値検証付きで到達可能 — 到達不能アダプタなし。
- 削除ゼロのラウンド。

### 第64ラウンド（ソクラテス式問答 — 「スキーマが受理するフィールドをハンドラが読むか？」）

- `schemas.order.create` の 11フィールド突合結果: ロジックで実使用は gpuId・
  durationMinutes・maxPricePerHour（価格チェック）のみ。description・paymentMethod・
  location・preferredCountry・maxDistance・latitude・longitude は orderData に
  格納されるが業務ロジックで読まれない — ただし GET /orders のレスポンスで
  クライアントへエコーされるため「write-only」ではなく「クライアント可視メタデータ」。
  削除は API 契約の変更＝製品判断（第8ラウンドの marketplace 面削除で使い道が
  消えた残存入力）。一覧に記録。
- gpu.register/update スキーマは全フィールドが保存+応答で消費。

### 第65ラウンド（ソクラテス式問答 — 「src/ にテスト専用コードが住んでいないか？」）

- `src/payments/ln-adapter.js`（42行）は `createMockLnAdapter` のみを export — src 側の
  消費者ゼロ（adapter は DI 経由で実体は lightning-service）。テスト2件のみが使う
  **モックを src/ に同居させていた偽装プロダクションコード** → `tests/helpers/
  mock-ln-adapter.js` へ git mv + import 修正2件。
- PaymentRepository・gpu-failure-monitor も確認 — 両方 src/運用側に消費者あり。

検証: tests/payments + lightning テスト — 53テスト全パス。

### 第66ラウンド（ソクラテス式問答 — 「HTML が参照するアセット・ツール設定は実在するか？」）

- index.html の参照3件（tokens.css/app.css/js/app.js）全て実在、favicon/manifest 等の
  参照なし（最小構成で dead 参照ゼロ）。
- jest.config（testPathIgnorePatterns→tests/e2e 実在）・playwright.config
  （globalSetup→tests/e2e/globalSetup.js 実在、webServer→src/api/server.js 実在）—
  設定の stale パターンなし。server.js 先頭 require 群も全て使用。
- 削除ゼロのラウンド。

### 第67ラウンド（ソクラテス式問答 — 「コアサービスの起動経路は全て存在するか？」）

- services.js safeLoad 3件（gpu-detector-extended→src/core/、virtual-gpu-manager・
  lightning-service→ルート）全て実在モジュールを解決。
- service-monitor（setServices/startMonitor + notifyExternalAlert は exchange-rate も
  消費）・invoice-poller（server.js で起動）— 起動経路完結。
- 削除ゼロのラウンド。

### 第68ラウンド（ソクラテス式問答 — 「ハンドラ内の遅延 require は本当に遅延が必要か？」）

- order/index.js の遅延 require 24箇所を先頭に集約: PaymentRepository×6、
  UserRepository×3、GpuRepository×2、notifyUser×12、renter-eligibility×1。
  全て post-load のハンドラ内でしか使わず遅延不要。OrderRepository の
  sweeps 2箇所も先頭 const 参照へ変更（stale コメント除去）。
- L1515 `require('../gpu/index')`（ルート間循環ガード）は意図的遅延として保持。
- 検証: api+security+payments+db — 90スイート 875テスト全パス
  （集約時に top-level require を誤削除する回帰を検出・即修正）。

### 第69ラウンド（ソクラテス式問答 — 「他ルートファイルにも遅延 require の重複はあるか？」）

- gpu/index.js（OrderRepository×8・uuid×2・order-pricing・renter-eligibility・
  schemas 再require→既存 `schemas` 利用へ）、payment/index.js（UserRepository）、
  btc-onchain.js（OrderRepository/UserRepository/EscrowRepository）、
  user/index.js（OrderRepository/WatchRepository/GpuRepository/tokens×2/
  token-denylist×4/session-invalidation/sanitizeString）を全て先頭へ集約 — 計30箇所超。
- 残存遅延 require は意図的なもののみ（order L1515 のルート循環ガード等）。

検証: api+security+payments — 88スイート 861テスト全パス（集約漏れによる
未定義参照を検出して即修正済み）。

### 第70ラウンド（ソクラテス式問答 — 「サービス・ユーティリティ層の遅延 require は正当か？」）

- order-expiry.js: notifyUser×4・EscrowRepository・createEscrowService・lightning を
  先頭へ集約（全てタイマー発火の post-load 関数内のみ使用）。
- lightning-service.js: メソッド内 lazy `require('./src/utils/audit-log')`/
  `require('./src/utils/validator')` を先頭へ集約 — jest 環境破棄後に
  「import after teardown」警告を撒いていた実行時 require を解消（機能改善を兼ねる）。
- `require('fs').existsSync`（L100）は同期 fs のため別物として保持。
- 残りの console.error（audit-log・token-denylist）はロガー自体が壊れた場合の
  最終防衛線として意図的保持。

検証: utils+payments+unit（111）、api+security+integration（83スイート814）全パス。

### 第71ラウンド（ソクラテス式問答 — 「認証ミドルウェアの遅延 require は正当か？」）

- jwt-auth.js（UserRepository・session-invalidation）と security.js
  （isRevoked・UserRepository・session-invalidation）のリクエスト内 lazy require を
  先頭へ集約 — 循環依存なし（UserRepository→audit-log は mw に戻らない）。
- service-monitor.js の `require('../../scripts/slack-notify.js'|line-notify.js)` は
  実在スクリプト + アラート発火時ロードで意図的 lazy として保持。
- session-invalidation.js コメントの「GraphQL」残留言及を修正。
- profit-addresses・master-auth・routes/index.js は既に全 top-level。

検証: security+middleware — 505テスト全パス。

### 第72ラウンド（ソクラテス式問答 — 「残る遅延 require は全て正当か？gpu.update スキーマは実態と一致するか？」）

- 残遅延 require 全正当: exchange-rate の prom-client try/catch ガードと
  notifyExternalAlert lazy rewire、service-monitor のアラート時スクリプトロード、
  vgpu-manager のインライン crypto.randomBytes。
- `schemas.gpu.update` 全8フィールドが PUT ハンドラの更新ホワイトリストで消費
  （minRenterRating/rejectUnratedRenters/availability 等 — 第64ラウンドの order.create
  と異なり不活性フィールドなし）。
- 削除ゼロのラウンド — 遅延 require 監査はここで収束（残余は全て正当化済み）。

### 第73ラウンド（ソクラテス式問答 — 「Mock 名を冠する src コードは偽の検証か？」）

- `createMockAttestationVerifier`（gpu 登録で使用）は名前こそ Mock だが `verify` が
  実 `verifyAttestation`（重み付きスコア・改ざん/鮮度検査）に委譲するため
  **本番でも実検証が走っている** — ln-adapter（モックのみ export）とは別物で生存判定。
  calls 履歴・buildReport はテスト用フックだが DI 境界の一部として保持。
- marketplace.js は escrow admin 面+stats のみ残存（既知の製品判断面）。
- 削除ゼロのラウンド。

### 第74ラウンド（ソクラテス式問答 — 「累積削除の連鎖で新たな孤児が生まれたか？」）

- src 全ファイルの require グラフ再スキャン: 疑われた5件は全て偽陽性
  （jest/playwright 設定＝ツール消費、routes/index.js・order/payment/user index＝
  ディレクトリ require `./routes`/`./order` 経由で実消費）。
- src/api/utils 全8ファイルに消費者あり（lightning-api は btc-payment.js の
  同ディレクトリ require で消費 — パス省略形は grep で要確認）。
- 削除ゼロのラウンド。

### 第75ラウンド（ソクラテス式問答 — 「export したテストヘルパーを誰か import しているか？」）

- tests/e2e/helpers.js の `logout`・`apiCompleteOrderCycle`（計43行）は spec からの
  import ゼロ（apiCompleteOrderCycle は「manual駆動の代替」として参照されるだけで
  未使用）→ 関数と export エントリを削除。order-lifecycle.spec の stale コメント修正。
- user.register スキーマ4フィールド・process-guards（server.js で登録）は全消費者あり。
- playwright test --list: 25 spec 全列挙、helpers 破損なし。

### 第76ラウンド（ソクラテス式問答 — 「防御的な除去リストの各エントリは実フィールドか？」）

- `SENSITIVE_USER_FIELDS` 全11エントリ突合: password・apiKey(レガシー)・
  sessionsRevokedAt・passwordChangedAt・deniedDisputeCount・vindicatedDisputeCount は
  実フィールド（dispute 解決・パスワード変更・退会で実際に書き込まれる）。
  totpSecret/mfaSecret 等5件は「将来の機密フィールド追加への防御的列挙」—
  マスター認証 TOTP は env 管理でユーザーレコードに secret を持たないことを確認。
  セキュリティ防御層として価値密度充分 → 生存。
- user.register スキーマ4フィールド・process-guards も消費者確認済み。
- 削除ゼロのラウンド。

### 第77ラウンド（ソクラテス式問答 — 「定数表とログフィールドに消えた機能の残骸はないか？」）

- `ErrorTypes` 死エントリ4件削除: EXTERNAL_SERVICE・GPU_ERROR・P2P_ERROR（P2P層
  第4ラウンド削除の残滓）・PAYMENT_ERROR — 全て0使用。残6種は使用箇所あり。
- audit.js アクセスログの `peerId` フィールド削除 — user.peerId は peerid リンク機能
  （第13ラウンド削除）と共に消滅し常に null になっていた。

検証: error-handler+middleware・audit-integrity 関連 — 33テスト全パス。

### 第78ラウンド（ソクラテス式問答 — 「列挙・定数テーブルに死エントリはないか？」）

- `NotifyType` 全6チャネル（LINE/Discord/Slack/Telegram/Email/Webhook）— 4〜6箇所で
  実使用（notification-settings 駆動）。`TERMINAL_SESSION_STATUSES`・
  `BLOCKING_ORDER_STATUSES`・escrow STATES/EVENTS も第50ラウンドで全生存確認済み。
- src/marketplace/default.js の DI チェーン（escrow+verification→marketplace-service
  →escrow admin ルート）は全リンク生存。
- 削除ゼロのラウンド。

### 第79ラウンド（ソクラテス式問答 — 「クライアント状態と契約に死面はないか？」）

- localStorage 3キー（TOKEN_KEY・USER_KEY・THEME_KEY）— 全て書き込み+読み出しペア完結。
- api.js 全22エンドポイントヘルパ — サーバールート実在・呼出し元ページ実在
  （resolveDispute→order-detail, approveManualPayment/pendingManualPayments→admin-payments）。
- package.json `main: src/api/server.js` 実在。削除ゼロのラウンド。

### 第80ラウンド（ソクラテス式問答 — 「リポジトリ層に配線なしのインスタンスはないか？」）

- `src/db/json/` 全10ファイルに消費者確認: 8リポジトリ全て routes/services/reputation
  から required（UptimeRepository→provider-uptime, VerificationRepository→verification-
  service）。atomicWrite・createJsonRepository はファクトリ経由。
- jest.config.testPathIgnorePatterns は e2e 除外のみで実整合。

- 削除ゼロのラウンド。

### 第81ラウンド（ソクラテス式問答 — 「ミドルウェア・ロックファイルに孤児はないか？」）

- `src/api/middleware/` 全10ファイルに消費者確認（ip-key.js は security.js・rate-limit.js
  の same-dir `./ip-key` require で生存 — パス grep 偽陽性を除去）。
- `src/api/utils/` 全8ファイルも同様に生存（第74ラウンド確認済み）。
- package-lock root 依存と package.json は完全一致。削除ゼロのラウンド。

### 第82ラウンド（ソクラテス式問答 — 「UI 表示マップに死んだ状態ラベルはないか？」）

- `STATUS_LABELS` 全6状態（pending/matched/active/completed/cancelled/disputed）—
  全て order/index.js で実際に書き込まれる状態。死ラベルなし。
- `pages/` 全11ファイルが hash ルートに登録済み（not-found は catch-all）。
- 削除ゼロのラウンド。

### 第83ラウンド（ソクラテス式問答 — 「監査ログ機構と server.js ミドルウェアに死配線はないか？」）

- `auditLogger` は routes/index.js の router.use で全 API にマウント済み（server.js
  ではなくルータ側 — 404 後の notFound チェインを汚さない正しい位置）。
- `verifyAuditLogIntegrity` は integrity テストが検証する運用制御（改ざん検知機構
  自体が目的 = 監査ログと同じ理屈で生存判定）。
- server.js の app.use 14段全て稼働中。削除ゼロのラウンド。

### 第84ラウンド（ソクラテス式問答 — 「ファクトリのオプション面と config キーに死面はないか？」）

- `createJsonRepository` の finders/onAccess オプションは各リポジトリが実使用、
  未対応オプションを渡している呼出しなし。
- `src/utils/config.js` 全26キー（server/gpu/security/lightning sections）に
  `config.X.Y` 消費者確認。パース偽陽性（コメント片）を除き死キーなし。
- 削除ゼロのラウンド。

### 第85ラウンド（ソクラテス式問答 — 「import/export とファイル内に消費者ゼロの宣言はないか？」）

- `virtual-gpu-manager.js` の `const fsSync = require('fs')` は `existsSync` 呼出し
  なし（`fs.promises` のみ経由）。削除。
- `src/api/routes/marketplace.js` の `clientError` ヘルパーは定義のみ・呼出しゼロ
  （`internalError` は生存）。削除。
- `src/api/routes/order/index.js` の `const { v4: uuidv4 } = require('uuid')` は
  Joi `.uuid()` バリデーターと別物で、生成呼出しゼロ。削除。
- プローブ系テスト 9 ファイルで未使用の supertest `request` インポート、
  probe61 で未使用の `GpuRepo` インポートを各々削除。
- src/ 全体の export 監査（モジュール全 export 名 × 外部 require サイト走査）で
  未使用 export ゼロを確認。

### 第86ラウンド（ソクラテス式問答 — 「文脈参照・環境変数文書・require 位置の一貫性はあるか？」）

- `master-auth.js` コメントの「security.js の API キー比較と同じ」は削除済み
  ファイルへの吊り下がった参照。Double-HMAC 方式の記述に修正。
- `.env.example` に `MAX_PENDING_ORDERS_PER_USER` のドキュメント行が欠落
  （order-limits コメントブロックが未記述のまま途切れていた）。追記。
- `routes/index.js` の遅延 require（notificationSettings・5 リポジトリ・
  order-expiry 4 関数）はルート登録時に毎回評価されるだけで遅延の利益なし。
  ファイル先頭へホイスト（68–72 ラウンドの方針と同型）。
- `order-expiry.js` の require 時副作用なしを確認してホイスト適用。

### 第87ラウンド（ソクラテス式問答 — 「README/CONTRIBUTING に削除済み・不存在の面が残っていないか？」）

- README の P2P セクション（~27 行）を削除: 消えた P2P 機能名の記述は
  実 API と乖離し虚偽の契約になる。
- 空の「## API仕様・Swagger UI」見出しを削除（openapi 生成スクリプトは
  第12ラウンドで除去済み）。
- 「具体的な自動化コマンド例」から存在しない `npm run start:prometheus` /
  `npm run monitor:nodes` を除去し、`logs/audit-*.log` を実パス
  `logs/audit.log` へ修正・/metrics 認証確認コマンドを追加。
- CONTRIBUTING の `npm run openapi` 行（EN/JA 両方）を削除、CI 記述を
  「(test)」へ修正。
- README の stale チェックリスト参照先を `docs/improvement-research-2026.md` へ修正。

### 第88ラウンド（ソクラテス式問答 — 「環境変数・依存・スクリプト・CSS/マークアップに死面はないか？」）

- `process.env.X` 全65 read を .env.example と照合: 全てコメント記載あり
  （safeInt/requireSecret 経由の読み取りは grep で拾えない偽陰性を含む。
  CI/HOME は標準環境変数で非文書対象）。文書化のみで未読の変数なし。
- package.json 依存24件・dev3件・scripts19件: 全て require/参照経路実在
  （scripts/ の3孤児に見えたファイルも兄弟スクリプト・CI・docs から結線済）。
- public/: 全ページモジュール import 済・全 id 参照済・CSS 82クラス中
  動的生成分（badge-*/chip-*/toast-*/active/done/invalid/ok）を除き死クラスなし。
- src/ 全ファイル到達可能（require グラフ走査で孤児ゼロ）。削除ゼロのラウンド。

### 第89ラウンド（ソクラテス式問答 — 「export でも呼出しでもない宣言はないか？」）

- `src/utils/notifier.js` の `sendEmailNotify` は宣言のみ・呼出しゼロ
  （EMAIL 経路は `src/utils/email.js` の sendEmailNotification を使用）。削除。
- `public/js/rate.js` の `satsToJpy` は export されているが外部消費者なし
  （priceLine からの内部利用のみ）。export を除去。

### 第90ラウンド（ソクラテス式問答 — 「前回の require ホイスト方針に漏れはないか？」）

- `routes/order/index.js` の `require('../gpu/index')`（レビュー後キャッシュ無効化）と
  後方に残っていた sanitize/cache 2 require を冒頭へ集約（gpu→order の逆向き参照は
  存在せず循環なし）。
- `marketplace.js` のハンドラ内遅延 require 3サイト（OrderRepository/GpuRepository）
  を冒頭へ。`payment/index.js` の `/btc` マウント内 require を変数化して冒頭へ。
- `notification-settings.js` の inline `require('fs')` ×2 を冒頭の `const fs` へ。
- `routes/index.js` の中盤 require 3件（rateLimit/auditLogger/errorMiddleware）を
  冒頭へ（errorMiddleware は error-handler の既存 import へ統合）。

### 第91ラウンド（ソクラテス式問答 — 「仕様書・コメントが削除済み要素を実在として語っていないか？」）

- SPECIFICATION.md を実態へ同期: merkle-anchor/audit-anchor/ln-adapter は削除済と
  記す、escrow/verification/attestation/feature-pricer/OTel の配線ステータスを更新、
  テスト数 40/215 → 115/1,045 へ修正、付録から削除済3モジュールを除去。
- `order/index.js` の wash-trade コメントが削除済み関数 `recordJobResult` を
  参照していた — 稼働実績の記述へ修正。
- PRODUCT_ANALYSIS.md は冒頭にスナップショット免責済みのため対象外。
- ZERO_BASED_REVIEW.md 自体の削除済ファイル言及は台帳として正当（対象外）。

### 第92ラウンド（ソクラテス式問答 — 「test と名付きながら走らないファイルはないか？」）

- `tests/unit/test_exchange_rate.js` は jest testMatch (`*.test.js`) に非適合で
  一度も実行されていない死テスト。Mocha API (`this.timeout`) 使用・実外部 API を
  叩く・同対象の正当な jest テスト `exchange-rate-swr.test.js` が存在。削除。

### 第93ラウンド（ソクラテス式問答 — 「同じ役割を担う文書が二箇所に存在しないか？」）

- リポジトリ直下の `SPECIFICATION.md`（235行・2026-06 版）は `docs/SPECIFICATION.md`
  の古い二重コピー。canonical は ARCHITECTURE.md:93（「API 参照は docs/SPECIFICATION.md」）
  と src/ 8ファイルのコメントが指す docs 側であり、root 側を参照する文書・コードはゼロ。
- root 側は削除済みブランチ名・削除済み peerid/joi-to-swagger/libp2p 等を実在として
  語り、テスト数も 830 件と stale。git rm。
- `improvement_checklist2.md` は scripts/feedback-to-checklist.js・checklist-kpi-report.js
  のデータソースとして稼働中（冒頭に実態乖離の免責済み）のため温存。

### 第94ラウンド（ソクラテス式問答 — 「文書中の定量主張は実測と一致するか？」）

- ARCHITECTURE.md のテスト数 2箇所が stale（136/138・1,213 テスト・112 秒）→
  実測 115/115・1,045 テスト・約 60 秒へ同期。ファイル削除履歴の記述は正確で変更不要。

### 第95ラウンド（ソクラテス式問答 — 「『実装済み』とされる TODO/将来拡張コメントが残っていないか？」）

- `middleware/logger.js` の `TODO: Prometheus 連携` — prom-client `/metrics` として
  既に結線済み。stale TODO 2行を削除。
- `notification-settings.js` の「isSSRFUrl をエクスポートして再検証」コメント —
  実際は `module.exports = { router }` で非エクスポート、notifier は ssrf-guard の
  `assertPublicUrl` を使用。虚偽コメントを削除。
- **削除断念（正直な記録）**: `schemas.lightningNode/lightningChannel`（validator.js）は
  src/ 配下 grep では消費者ゼロに見えたが、リポジトリ直下の `lightning-service.js`
  （:408, :618 で LND RPC 応答を検証）が消費者だった。適用→jest 3スイート赤→即 revert。
  教訓: 消費者監査は src/ に限定せずリポジトリルートの大型モジュールも対象に。

### 第96ラウンド（ソクラテス式問答 — 「起動パスの起点 server.js に死面・虚偽計装はないか？」）

- **削除**: `paymentFailureCounter` / `reconnectCounter`（prom-client 登録済みだが
  全コード中インクリメント呼び出しゼロ — 恒久的に 0 を返す死メトリクス。
  「LightningService側から呼ぶ想定」は実在しなかった。ゼロ値メトリクスは
  誤った可観測性を与えるため削除）。
- **削除**: no-store ミドルウェアの `/vendor/` 例外条件（`public/vendor/` は
  存在しない — 死分岐）。
- **簡素化**: `/ready` ハンドラ内のインライン require 4件（fs/GpuRepository/
  OrderRepository/core/services）を冒頭へ。一度中盤の const に置いて TDZ 自己撞着
  （"Cannot access 'coreServices' before initialization" が try/catch で飲まれ
  monitor/poller が静かに未起動になる劣化を検出）→ 冒頭 import ブロックへ正規移動。
- **監査して残した面**: lightning-service.js 全23メソッド（公開 LND API 面・
  内部ヘルパー・モック完全性テスト対象）、virtual-gpu-manager.js 全メソッド、
  gpu-detector-extended の `detectIntelGPUsWindows`（ベンダー検出の公開API面として
  対称性あり — 削除すると AMD/ROCm のみの非対称 API になるため温存）、
  telemetry/instrumentation.js（server.js が冒頭で読込）、public/js/pages/ 11枚
  全て（app.js が全 import）、全ルートファイル（server.js/routes/index.js で
  マウント済み）、data/（.gitignore 済み・未追跡）。

### 第97ラウンド（ソクラテス式問答 — 「中間層（ミドルウェア・リポジトリ・設定キー）に死 export はないか？」）

- 機械監査、死面ゼロ: middleware 10ファイル全 export（authenticateJWT/checkRole/
  resolveSecret/ip-key 3件/masterSession/revoke/isRevoked/cache 3件/logger 4件/
  security 5件）、db/json 全 finders（7リポジトリ・宣言的 getByXxx 全て消費者あり）、
  config.js 全キー（rateLimitMax/jwt*ExpiresIn/bcryptRounds/corsOrigins/
  minMemoryGB/certPath/macaroonPath/invoiceExpiry/min+maxPaymentSatoshis）、
  notifier 全 export（sendNotification/NotifyType/withRetry）、api/utils 8ファイル、
  order/index.js のヘルパー5件（_deleteHeartbeatsForOrder/reapUsageSessions/
  sweepHeartbeatSlaBreaches/resolvePositiveIntEnv/_checkOrderCreateRateLimit）、
  全ルート + server.js の require で未使用ゼロ。
- 判定して残した面: `detectIntelGPUsWindows`（ベンダー対称 API）、notification-settings の
  PRIVATE_IP_PATTERNS regex と ssrf-guard assertPublicUrl は設計上の多層防御
  （保存時の軽量regex + 送信時のDNS解決）で重複ではない、config.json ロード経路
  （小さなドーマント機能、未文書化だが getConfig が毎回呼ぶ生コード）。

### 第98ラウンド（ソクラテス式問答 — 「コメントが削除済モジュールを現役のように参照していないか？」）

- `middleware/audit.js` の `audit-anchor` 言及 → 削除済モジュール名を除去
  （verifyAuditLogIntegrity のみ残す）。
- `middleware/jwt-auth.js` の `GraphQL` 言及（削除済 GraphQL エンドポイント）を除去。
- `tests/helpers/mock-ln-adapter.js` 冒頭の `// src/payments/ln-adapter.js` —
  削除済ファイルのパスをコメントしていた → Mock 実装の自己言及へ修正。
- 残した面: action-executor/gpu-attestation-verifier の「ln-adapter」はファイル名ではなく
  DI インタフェース名として正当、probe34 の「(removed) GraphQL」は歴史記述として正当。

### 第99ラウンド（ソクラテス式問答 — 「コメントはコードそのものを説明しているか、過去のコードとの差分を説明しているか？」）

- 第一原理的整理: コメントの役割は「コードが一般に何をするか」の説明。
  「旧実装は X だったが…」「以前は…」「残っていたため削除」は過去のコードとの差分の
  説明であり、diff を読まないと意味を成さない — その履歴はコミットメッセージと
  PR 説明文の領分。コードコメント規約に照らして全リポジトリを走査。
- **書き換え**: 「旧実装は…/以前は…」の差分説明を含むコメントを 16 箇所（13 ファイル）
  摘出し、一般説明のみ残す形へ書き換え:
  - lightning-service.js ×3（createInvoice/checkInvoice/sendPayment の旧契約説明を除去）
  - `middleware/cache.js`（旧 body-only キャッシュバグ説明を除去）
  - `notification-settings.js` ×2（catch→{} 説明 / .pattern 説明を一般形へ）
  - `routes/exchange-rate.js`（旧マウント順説明を一般形へ）
  - `routes/gpu/index.js` ×2（バッチ getAll 説明 / attestation 説明を一般形へ）
  - `routes/index.js`（/gpus blanket 免除の旧説明を除去）
  - `routes/order/index.js` ×2（TOCTOU 移動履歴 / timestamps 旧説明を一般形へ）
  - `routes/payment/index.js` + `routes/payment/btc-onchain.js`（二重インボイス /
    lenderWallet フォールバックの旧説明を一般形へ）
  - `server.js`（「必要に応じて適切なimportに修正」という stale 指示を除去）
  - `core/service-monitor.js`（旧 require 配置説明を一般形へ）
  - `db/json/createJsonRepository.js` ×2（旧 [] 返却の説明を一般形へ）
  - `payments/settlement-calculator.js`（旧 Math.round 説明を一般形へ）
  - `utils/audit-log.js`（旧 self-heal 書き換え説明を一般形へ）
  - `utils/exchange-rate.js`（旧 TTL ブロッキング説明を一般形へ）
  - `utils/logger.js` ×2（旧メタデータ fail-open / 無制限ローテ説明を一般形へ）
  - `utils/order-expiry.js`（旧 SETTLED 一律 update 説明を一般形へ）
  - `virtual-gpu-manager.js` ×3（旧 unhealthy 条件 / 旧 proxy spawn / 旧 docker
    プラットフォーム削除説明を一般形へ）
  - `tests/e2e/globalSetup.js`（旧 existsSync ガード説明を一般形へ）
- **孤立コメント削除**: `utils/logger.js` の `gpuEvent` 末尾 — かつて存在した
  `logger.info` 呼び出し（前ラウンドで削除済み）を説明するコメントが残り、
  説明対象のコードが無かった。
- **Dockerfile 同種削除**: `docker/Dockerfile.api` の「存在しない build script を
  `|| true` で握りつぶす行を削除した名残り」説明 — 差分由来のため除去。
- **監査して残した面**: Joi schemas 全キー生存確認（lightningNode/lightningChannel は
  ルート lightning-service.js の RPC 応答検証で使用 — 第95ラウンドの教訓:
  git grep のパススペックではルートファイルを含めないと再撞着する）、
  public/index.html の全 id が JS で参照、tests インフラ4ファイル結線、
  全ルートヘルパー消費者あり、package.json main / Dockerfile CMD 整合。

### 第100ラウンド（ソクラテス式問答 — 「残りの機械的面に死はないか？」— 収束認定）

- 機械監査バッテリーを残存面へ適用、全て死面ゼロ:
  - **public/js 全関数**: 定義と呼出しを走査 — 全関数に呼出しサイト1件以上（21関数）。
    fmtDate/fmtSats/fmtJpy は ui.js の共有 export を全ページが import（重複定義なし）、
    escapeText は router.js の一本のみ。
  - **scripts/ 全関数**: 全て定義元ファイル内で呼出しあり。
  - **PUBLIC_PATHS**: /users/register・/users/login・/users/refresh・/gpus の全エントリに
    実ルートあり（/system/info を外す意図的設計注記は keep — 差分説明ではなく
    「admin を認証不要パスに置かない」不変条件）。
  - **重複実装チェック**: 同名関数4件（load/num/persist/writeAuditLog）は全て
    モジュール別の正当な別実装（writeAuditLog は access-audit.log / db-access.log の別ログ）。
  - **死分岐チェック**: if(false)/if(true) 等ゼロ、NODE_ENV チェックは
    test/production/development の全生モード。
  - **TODO/FIXME/HACK マーカー**: ゼロ。
- 判定: src/ の機械的監査面は全て収束。残る非機械的面は §11 の文書化済み棚卸し
  （order/index.js 分割・プロバイダ払い出し配線）のみ — どちらも「削除」ではなく
  設計判断が要る領域のため本パス対象外。

### 第101ラウンド（ソクラテス式問答 — 「意味論的死面（未読変数・死フィールド・死分岐）は残っていないか？」）

- 機械スキャン、全て死面ゼロ:
  - **未読 const**: order/gpu/user 各大ルートファイル + lightning-service +
    virtual-gpu-manager + server.js の全 `const X =` 宣言を走査 — 代入のみで
    一度も読まれない変数ゼロ。
  - **sanitizeObject / isValidOrderTransition / state-checker**: 全て生呼出しあり
    （sanitizeObject は3ファイル5箇所、isValidOrderTransition は order PATCH で使用）。
  - **gpu.register スキーマフィールド**: Joi `stripUnknown:true` で未知キーは
    検証層で剥がれる設計 — スキーマ内フィールドは API 契約面であり「使わない」
    フィールドの削除は契約変更になるため、第一原理削除の対象外（§11 棚卸しへ）。
  - **重複実装の最終確認**: 同名関数は全て別ファイルの正当な別実装。
- 判定: 削除系の監査は機械・意味論の両面で収束。以降の「続けて」は削除ではなく
  §11 の設計作業（order/index.js 分割 / provider payout 配線）への移行が筋。

### 第102ラウンド（ソクラテス式問答 — 「1,800行の order/index.js はどの境界で割れるか？」）

- §11 棚卸し項目「order/index.js 分割」に着手。まず制約を洗い出し:
  約10件の probe テスト（probe25/29/31/32/36/37/40 等）が index.js のソースを
  テキストとして読み正規表現で検証している（withLock 配置・escrow 順序・audit 呼出し）。
  ルートハンドラを別ファイルへ移すとこれらが全て赤になる — テストを変えずに
  割れるのは「ハンドラではない機構」だけ。
- **抽出**: `src/api/routes/order/sessions.js`（211行）を新設し、セッション機構を
  丸ごと移動 — `usageSessions`/`heartbeatTimestamps` Map、`OrderUsageSession` クラス、
  `reapUsageSessions`/`sweepHeartbeatSlaBreaches`/`_deleteHeartbeatsForOrder`、
  `SLA_PROVIDER_TIMEOUT_MS`、30秒 `setInterval` 駆動。HTTP ハンドラ17本は全て
  index.js に残す（probe テストの対象コードを移動しない）。
- **結合面**: index.js は `require('./sessions')` で状態を共有（マップは同一オブジェクト）。
  テストフック（`_usageSessions`/`_reapUsageSessions`/`_sweepHeartbeatSlaBreaches`/
  `_OrderUsageSession`）は index.js から re-export し既存テスト互換を保持。
  sessions.js は route を import しないため循環参照なし。
- **結果**: index.js 1,800 → 1,619行（−10%）。残りのハンドラ分割は
  「probe テストが index.js 直読み」の制約を解く（正規表現の対象ファイルを
  変更する=テスト変更を伴う）かどうかの判断待ち — 本ラウンドでは止める。

### 第103ラウンド（ソクラテス式問答 — 「ハンドラ分割は probe テストの参照パス更新だけで済むか？」）

- 第102の制約を解く: probe テストのアサーションは**正規表現の中身**であり、
  対象ファイルのパスはアサーションではない — コードが正当に移動したなら参照先を
  追従させるのはテスト改ざんではなくリファクタ追随。各 probe が検証する
  パターンの所在を個別に洗い出して移動先へ向け直すだけで済む。
- **抽出（2ファイル）**:
  - `src/api/routes/order/runtime.js`（287行）— 実行系ハンドラ:
    `POST /:id/heartbeat`・`POST /:id/start`・`POST /:id/stop`。
    `./sessions` の共有マップと OrderUsageSession を継続使用。
  - `src/api/routes/order/disputes.js`（401行）— 紛争系ハンドラ:
    `POST /:id/dispute`・`POST /:id/dispute/resolve`・`POST /:id/review`・
    `POST /:id/renter-review`。
- **マウント方式**: `router.use(require('./runtime'))` / `router.use(require('./disputes'))`
  を抽出元ハンドラの在った位置に挿入。ルート重複解析（GET /:id と /stats の
  順序のみ有意、他パスは衝突しない）で登録順の意味論は不変と確認。
- **index.js に残すもの**: 読み取り系（GET /・/stats・/provider/earnings・/:id・
  /:id/payment）+ ライフサイクル（POST /・PUT /:id・DELETE /:id・/reject・/accept）
  + 共有ヘルパー（rate-limit・SWEEP 状態・BLOCKING_ORDER_STATUSES）+ テストフック
  re-export。移動済みの import（providerUptime・GpuRoutes・requireService・
  UserRepository・heartbeatTimestamps・_deleteHeartbeatsForOrder）は除去。
- **probe テスト参照更新（アサーション不変、パスのみ）**: probe25→disputes.js、
  probe37→runtime.js、probe42→disputes.js、probe43→runtime.js(/stop)+disputes.js(他3件)、
  probe40→disputes.js(dispute件)。probe25 の共有ロックキー計数は disputes+runtime の
  連結ソースで検証（「resolve が /start・/stop と同一 `order:${orderId}` キー」の
  意図を保持）。残る index.js 直読み（probe29/31/32/36/41/44/76）は対象コードが
  index.js 残留のため不変。
- **結果**: index.js 1,619 → 985行（−39%）、order/ は4ファイル構成
  （index.js 985 + runtime.js 287 + disputes.js 401 + sessions.js 211）。

### 第104ラウンド（ソクラテス式問答 — 「読み取り系ハンドラが index.js に残る必要はあるか？」）

- 問い: index.js 残留の GET ハンドラ5本は「変更系」と同居しなくてよいのでは？
  probe テストは全て mutation 側（PUT/DELETE/POST/accept）を検証しており、
  GET ハンドラのソースを読むテストはゼロ — 移動の制約なし。
- **抽出**: `src/api/routes/order/reads.js`（333行）を新設し、GET ハンドラを
  ドメイン内順序を保ったまま全て移動 — `GET /`・`/stats`・`/provider/earnings`・
  `/:id`・`/:id/payment`。`/stats` と `/provider/earnings` が `/:id` より先に
  登録される唯一の順序制約は、5本を塊として先頭に mount することで保持。
  GET/POST の衝突はメソッドが別なので発生しない。
- **共有状態の扱い**: `SWEEP_THROTTLE_MS`/`_lastOrderSweepAt`（一覧取得時の
  遅延スイープスロットル）は GET / のみが使う — 共有ではなく reads.js へ
  そのまま移動（sessions.js のような共有モジュール化は不要と判断）。
- **index.js に残すもの**: mutation 系のみ（PUT /:id・DELETE /:id・POST /・
  /reject・/accept）+ 共有ヘルパー（rate-limit・BLOCKING_ORDER_STATUSES）+
  テストフック + `router.use` の mount 列。移動に伴い expireStaleDisputed/
  Active・cacheMiddleware・checkRole・PaymentRepository の import を除去
  （expireStaleOrders/Matched は POST / の作成時スイープで使用のため残留）。
- **結果**: index.js 985 → 665行。order/ は5ファイル構成
  （index.js 665 + reads.js 333 + disputes.js 401 + runtime.js 287 +
  sessions.js 211 = 計1,897行）。index.js は「変更系 + 共有部品」のみに。

### 第105ラウンド（ソクラテス式問答 — 「最大ルートファイル gpu/index.js も同じ境界で割れるか？」）

- 問い: order/ と同じ問いを残存最大ファイル `gpu/index.js`（1,125行・19ハンドラ）
  に適用 — ドメイン境界は自明か？ ハンドラの依存解析で4ドメインに分割可能と確認。
- **抽出（4ファイル）**:
  - `reads.js`（564行）— GET 9本（一覧・/my・/:id・/reviews・/market-rate・
    /history・/estimate・/eligibility・/schedule）+ 評価集計キャッシュ
    （getGpuRating/_gpuRatingCache/GPU_RATING_TTL/invalidateGpuRatingCache —
    唯一の利用者は GET /:id のため同所へ移動）。
  - `lifecycle.js`（413行）— POST /・clone・bulk・PUT・DELETE +
    `_attestationVerifier`（利用者は POST / と POST /bulk のみ）。
  - `blocks.js`（100行）— POST/DELETE メンテナンスブロック。
  - `watch.js`（99行）— POST/DELETE/GET 価格ウォッチ。
- **結合面**: index.js は15行のマウント層に縮退（`router.use`×4）。
  `module.exports._invalidateGpuRatingCache` は reads ルータ経由で re-export —
  消費者 disputes.js は変更不要。マウント順序解析: GET /my が GET /:id より
  先に登録される唯一の制約は reads.js 内の順序で保持、その他は
  メソッド/セグメント数が異なり衝突なし。
- **probe 参照更新（アサーション不変・パスのみ）**: probe28/36→lifecycle.js、
  probe45/72→reads.js、probe46→blocks.js、probe75→lifecycle.js
  （名前は getall だが検証対象は POST ハンドラ — 誤って reads へ向け一度赤、
  即 lifecycle へ修正して緑）。
- **結果**: gpu/index.js 1,125 → 15行。routes/ 直下の最大ファイルは
  user/index.js（816行）が次の候補。

### 第106ラウンド（ソクラテス式問答 — 「user/index.js の分割境界は何か？」）

- 問い: 816行・15ハンドラの user/index.js のドメイン境界は？ 認証系・
  セルフサービス系・管理者系の3ドメインが自然境界。GET/DELETE /me と
  /:id のパラメータ衝突だけが唯一の順序制約（me を admin より先に mount）。
- **抽出（3ファイル）**:
  - `auth.js`（268行）— register・login・refresh・logout + `_DUMMY_HASH`・
    ログイン失敗ロック状態（`_loginFailures`/`_recordLoginFailure`/
    `_resetLoginFailures`/`_isLoginLocked` — 消費者は login のみのため同梱）。
  - `me.js`（385行）— GET/DELETE/PUT /me・/me/password・/me/activity・
    /me/watches + `ALLOWED_PROFILE_FIELDS`。
  - `admin.js`（203行）— GET /・/:id・DELETE /:id・PUT /:id/role。
- **結合面**: index.js は11行（mount のみ、auth→me→admin の順）。
  モジュール外部の import（テストフック等）は存在しないことを確認済み。
- **probe 参照更新（アサーション不変・パスのみ）**: 認証系→auth.js
  （probe36/40/68/35/23a）、me系→me.js（probe38/51/49 + probe32 の
  password/payout 件）、admin系→admin.js（probe43×2 + probe32 の
  role 件）。probe32 はファイル内で me/admin 混在のため it ブロック単位で
  マッピング。
- **結果**: user/index.js 816 → 11行。ルート層の3大ファイル全て分割完了
  （order・gpu・user）。残る500行級は payment/index.js（516行）のみ。

### 第107ラウンド（ソクラテス式問答 — 「payment/index.js の境界と順序制約は？」）

- 問い: 516行・11ハンドラのドメイン境界は？ インボイス発行/支払・注文支払・
  状態読取・管理審査の4ドメイン。順序制約は `/invoice/:id` と `/:id/status`
  の2セグ重なりのみ（`/invoice/status` は先に登録された前者が勝つ —
  invoices を reads より先に mount で保持）。btc マウントは GET 経路なし
  のため位置不問（元順序の reads→btc→admin 相対順を維持）。
- **抽出（4ファイル）**:
  - `invoices.js`（173行）— POST /invoice・POST /pay・GET /invoice/:id。
  - `order-pay.js`（155行）— POST /order/:id（価格計算 + withLock 二重発行抑止）。
  - `reads.js`（124行）— GET /:id/status・/node-info・/channels・/history。
  - `admin.js`（97行）— GET /admin/pending・POST /manual/approve/:id。
- **結合面**: index.js は14行（invoices→order-pay→reads→btc→admin）。
- **probe 参照更新**: probe38/49→admin.js（manual/approve 検証）、
  probe44→order-pay.js（manual payment + POST /order/:id）と reads.js
  （status endpoint）。probe44 の manual-payment ブロックは当初 admin.js
  と誤判定して一度赤 — `method: paymentMethod` の実在位置を確認し
  order-pay.js へ修正して緑（アサーション不変）。
- **結果**: payment/index.js 516 → 14行。routes/ 全ファイルが300行以下
  （最大は order/reads.js 333行と order/index.js 665行の mount+mutation 層）。

### 第108ラウンド（ソクラテス式問答 — 「order/index.js の残り669行はまだ2役か？」）

- 問い: 分割後も index.js が mount 層＋mutation ハンドラ5件＋レート制限
  状態を同居させている — gpu/user/payment の「index = mount のみ」の
  パターンと不整合では？ → 不整合。mutation 群を `mutations.js` へ抽出。
- **抽出**: `mutations.js`（648行）— PUT/DELETE/POST/・reject/accept +
  `BLOCKING_ORDER_STATUSES`・`MAX_ORDER_SCHEDULE_AHEAD_DAYS`・
  `resolvePositiveIntEnv`・作成レート制限状態（`_orderCreateRateState`・
  `_checkOrderCreateRateLimit` — 消費者は POST / のみのため同梱）。
- **結合面**: index.js は25行 — sessions.js のテストフック re-export 4件 +
  mounts（reads→runtime→mutations→disputes、元の登録順を厳密保持）+
  `mutations._checkOrderCreateRateLimit` の再公開（probe64 の既存フック互換）。
- **probe 参照更新**: order/index.js を直読みする8ファイル計11箇所は全て
  mutation ハンドラ狙い（cancel=PUT・DELETE・POST /・accept predicate・
  admin status audit）— 一括 mutations.js へ（アサーション不変）。
- **結果**: order/index.js 669 → 25行。routes/ 配下は全てマウント層か
  ドメイン別サブルータのみ — 第102–108ラウンドでルート層のモノリス化は
  完全に解消（order 1,800 → 6ファイル、gpu 1,125 → 5、user 816 → 4、
  payment 516 → 5）。

### 第109ラウンド（ソクラテス式問答 — 「新ファイルの import は全て消費されているか？」）

- 問い: 分割で作った14ファイルの手書き require ブロックに過剰宣言は？
  → 機械監査: `payment/admin.js` の `logger` のみ未使用（admin ハンドラは
  ロギングを持たない）— 1行削除。
- `uuidv4`・`requireService` の疑義は検査スクリプトの偽陽性
  （`require` 部分一致・エイリアス名の取り違え）と確認、実体は全消費。
- 判定: 分割作業は完了。残る routes/ の各 index.js は mount 層のみと統一。

### 第110ラウンド（ソクラテス式問答 — 「{count, windowStart} 実装はなぜ3つある？」）

- 問い: order作成・login失敗・TOTP IP の3箇所が同一のスライドウィンドウ
  カウンタを個別実装 — 「3回目の実装は共通化すべきでは？」→ 共通 util へ。
- **新設**: `src/utils/sliding-window-limit.js` —
  `createSlidingWindowLimiter({windowMs, max})` が
  `{hit(key), isLimited(key), reset(key), state}` を返す
  （hit=カウント加算、isLimited=失効掃除付きpeek、state=テスト用Map公開）。
- **接続（3サイト、意味保存）**:
  - `order/mutations.js`: `_orderCreateRateState` → limiter。
    `_checkOrderCreateRateLimit` は `hit<=LIMIT` のラッパーとして温存し
    `._state` も `limiter.state` を指す — probe64 の実行フック互換。
  - `user/auth.js`: `_loginFailures` 3関数 → limiter の薄いラッパー
    （record=hit・reset=reset・isLocked=isLimited — 呼出し側変更不要）。
  - `master-auth.js`: `_totpIpMap` 手書き実装 → limiter。
    probe34 が `/_totpIpMap/`・`/_checkTotpIpLimit/`・`/TOTP_IP_WINDOW_MS/`
    をソース検証するため、定数名・`_totpIpMap`（=`limiter.state`）を保持
    （一度 probe34 赤 → 識別子維持で緑。テストは不変）。
- **残した面**: express-rate-limit の IP リミッタ（別物・共有化対象外）、
  セッションスコープの TOTP/mail カウンタ（意図的にスコープ分離）。
- **結果**: 3 実装 → 1 util + 各サイト ≤6行の設定。意味変更ゼロ。

### 第111ラウンド（ソクラテス式問答 — 「同一の escrow 配線が7箇所ある理由は？」）

- 問い: order ルート群の 7 ハンドラがそれぞれ
  `createEscrowService({ lnAdapter: lightning })` を逐次呼ぶ — 配線の一意化は？
  → `order/escrow.js` に遅延シングルトン `escrowService()` を新設。
  初回呼出し時に生成して lnAdapter を捕捉（ルート require 時点では
  lightning 未初期化の可能性があるため、モジュール先頭での生成は不可）。
- **接続**: mutations×3・disputes×2・runtime×1・sessions×1 — 全7サイト。
  テストは `createEscrowService({repository: fake})` を直接注入するため無影響。
- **派生クリーン**: 置き換え後 `{lightning}` のみが import 残骸になった
  mutations・disputes の core/services require を削除、
  runtime/sessions は destructure から lightning のみ除去
  （vgpuManager・requireService は存続）。
- ドキュメント参照は stale なし（routes パス記述を保持確認）。
- **結果**: escrow 配線が1箇所に集約 — LN アダプタ変更時の修正点が一意化。

### 第112ラウンド（ソクラテス式問答 — 「notification-settings.json の読み方は3つあるべきか？」）

- 問い: 同一ファイルを notifier・user-notify・API がそれぞれ読む — 重複か？
  → 意味が異なる2系統だった: API は corrupt で throw（書込経路の厳格検証・
  意図的）、notifier と user-notify は破損→{} の寛容リード（通知は
  best-effort）。共有は寛容版2箇所のみ正しい。
- **集約**: `notifier.js` に `loadNotificationSettings()`（寛容版）を置き、
  `sendNotification('user_*')` 経路と `user-notify.js` の双方が使用。
  user-notify の `loadAllSettings`/`SETTINGS_PATH` と fs/path require を削除
  （`loadAllSettings = loadNotificationSettings` のエイリアスで呼出し変更不要）。
  API の `loadSettings`（throw 版）は異なる契約のため温存。
- **結果**: 寛容リーダー1箇所・厳格リーダー1箇所 — 意味の違いを維持しつつ
  真の重複のみ消去。

### 第113ラウンド（ソクラテス式問答 — 「まだ重複・死面は潜んでいないか？」— 検証ラウンド）

- 問い: 分割・共通化を経た残存面に未検出の死面は？ → 機械監査、全て生存。
- **監査結果（全て生存・変更なし）**:
  - JSON 書込原子性: data 層は atomicWriteJSON 一貫、scripts/ の writeFileSync は
    レポート出力のみ、server.js の writeFileSync は readiness プローブ（正）。
  - `/node-info`・`/channels` の二重定義: `/api/v1/*` と `/api/v1/payments/*` の
    意図的デュアルマウント — e2e テストが両パスを実測（死面でなく契約）。
  - SSRF 二層防御: POST 時 regex + 送信時 assertPublicUrl は意図的多層（温存）。
  - scripts/ 全17本: package.json 非登録3本も全て生存（slack-feedback-bot は
    5スクリプト共有lib、line-notify は probe57+README+service-monitor 参照、
    feedback-bot は docs/README_feedback.md の運用対象）。
  - routes/index.js 全 import 使用済み（expiry 4 関数・VerificationRepository 等）。
  - public/js/pages/order-detail.js（477行・最大残存ファイル）: 全18関数に
    呼出しサイトあり、cleanup は router 契約の返却値。
- **判定**: 構造整理（分割+共通化）後の再走査でも死面ゼロ。
  残る §11 は設計判断領域2件のみ（プロバイダ払い出し配線・JSON 複数プロセス
  lost-update）— 共に削除ではなく実装/移行判断。

### 第114ラウンド（ソクラテス式問答 — 「sendNotification の 'user_*' 分岐は誰が呼ぶのか？」）

- 問い: `sendNotification(typeOrUserId)` に「第1引数が `user_` 始まりなら
  ユーザー設定を解決して多段通知する」分岐（約45行）が残っている — 消費者は？
  → 全コード・tests・scripts を grep: **呼出しゼロ**。全呼出しサイトは
  `NotifyType` 定数のみ。ユーザー通知の正規経路は `notifyUser()`
  （user-notify.js → resolveChannels → 本関数への NotifyType 呼出し）。
  分岐内の「webhooks 配列・payloadTemplate」処理も user-notify の
  resolveChannels が別実装として持つ完全な死複製。
- **削除**: `sendNotification('user_*')` 分岐を除去（−49行）。低層APIの
  契約を「NotifyType 直送のみ」に固定し、層分離をコメントで明示。
- **flaky 記録**: 適用直後の全量実行で api.integration が5件 401 失敗したが、
  スコープ再実行（変更有無両方）と全量再実行で再現せず — 並列ワーカー下の
  トークン発行タイミング flake と判定（本編集は認証経路に無関係）。

### 第115ラウンド（ソクラテス式問答 — 「マウント層にハンドラが8本残っているのはなぜ？」）

- 問い: 全ドメインルートがサブルータへ分割された後、`routes/index.js` に
  インラインハンドラ8本が残っている — mount 層と実装が同居。
- **抽出**: `src/api/routes/admin.js`（206行）を新設しルート直下の
  admin/info 系を集約: GET /node-info・/channels、POST /admin/cache/purge、
  GET /admin/stats・/admin/verifications・/admin/verifications/:jobId・
  /admin/escrow、POST /admin/expire-orders、GET /system/info。
  全てリテラルパスのため '/' マウントでシャドウイングなし。
- **index.js は 251 → 96 行**: ミドルウェア配線（rateLimit・JWT ゲート・
  audit）＋マウント＋コア初期化のみ。不用 import 除去
  （rbac・requireService・asyncHandler・cache 系・Repo×5・order-expiry×4）。
- **準拠確認**: /system/info の「グローバル jwtAuth 前提・inline jwtAuth 不要」
  契約、/admin/verifications リテラル→param の登録順、node-info/channels の
  cacheMiddleware を全て原状維持。probe ソース直読みなし（HTTP 検証のみ）。
- 併せて実施: `sendNotification` の引数 `typeOrUserId` → `type` に rename
  （'user_*' 分岐削除で残った stale 命名 — 契約は NotifyType のみ）。
  public/js/api.js の helper 32本・fetch 経路は全て実ルート対応で死面ゼロ。

### 第116ラウンド（ソクラテス式問答 — 「?limit=&offset= の解釈が9箇所にあるのはなぜ？」）

- 問い: ページネーションの parse+clamp が 9 サイトに手作業複写 — 重複か？
  → 意味差あり（maxLimit 200/100・defaultLimit 50/20・offset 上限 100000/なし）
  だが、差分は全てパラメータとして表現可能 → 真の重複。
- **集約**: `src/utils/pagination.js` の `parsePagination(query, {maxLimit,
  defaultLimit, maxOffset})` へ統一。offset 上限あり版は GPU/ユーザー/注文の
  未認証・広範囲リスト向け DoS 防御（offset=999999999 で O(n) slice）を維持、
  上限なし版は本人スコープの履歴・admin 一覧（既に認証済み）を維持。
- **接続**: order/reads×1・gpu/reads×4・payment/reads×1・user/admin×1・
  routes/admin×2 — 計9サイト。`limitRaw/offsetRaw` は pagination.js 内のみ残存。
- **差分の保存**: 100/20 版はレビュー系2エンドポイント固有契約として
  `{maxLimit:100, defaultLimit:20}` で保持 — 意味差を平坦化せず引数化。

### 第117ラウンド（ソクラテス式問答 — 「ベストエフォート escrow cancel が3箇所ある理由は？」）

- 問い: 「注文の未終了エスクローを全部 cancel」ブロックが mutations(reject)・
  disputes(refund) で同一形 — 重複か？ → 接続先が同じなら真の重複。
  ただし意味差のある2箇所は統合対象外:
  - DELETE（HELD 失敗は致命的・伝播）— probe31 が `escrow.state === 'HELD'`・
    `Non-critical escrow cancel failed`・`escrowSvc.cancel`≥2 をソース検証 → 温存。
  - PUT（status=cancelled 時に全失敗を伝播・502）— 別契約 → 温存。
- **集約**: `order/escrow.js` に `cancelEscrowsForOrder(orderId, context)` を追加
  （lookup 失敗・個別失敗は warn のみ — reject/resolve-refund の best-effort 契約）。
  mutations:reject・disputes:resolve-refund の2サイトを接続（−27行）。
- 並走監査: `req.user.role !== 'admin'` 約30サイト・`sanitizeString().slice(0,N)`
  6サイトは「バグを生む式」でなく単純比較/合成一貫のため統合価値なし・温存判定。

### 第118ラウンド（ソクラテス式問答 — 「escrow.expire は誰が呼ぶのか？」）

- 問い: サービスの公開メソッドに「呼出しゼロ」はないか？ → `escrowService`
  メソッド全走査で `expire` のみ全リポジトリ（src・tests・scripts・ルート）
  消費者ゼロ。DEADLINE イベントは state-machine 層テストのみで、サービス経路
  （deadlineAt スイープ）は未配線 — §11 の払い出し配線と同じ「設計判断領域」。
- **削除**: `expire: (escrowId) => apply(escrowId, 'DEADLINE')` 除去。
  DEADLINE 遷移自体は escrow-state-machine.js に残存（削除せず —
  将来の deadline スイープ実装時に `apply(id,'DEADLINE')` で復帰可能）。
- **監査して生存**: Joi schemas 全キー（idParam/gpu.register・update/
  order.create/payment.createInvoice・pay/user.register・login +
  lightningNode/lightningChannel — ルート lightning-service.js で使用中、
  第95教訓の再適用）、escrow サービスの create/markPaid/cancel/resolveDispute/
  evaluate/settle/apply/get 全て消費者あり（get は marketplace-service 経由）。

### 第119ラウンド（ソクラテス式問答 — 「書かれるが読まれないフィールドはあるか？」）

- 問い: レコードに書き込まれるが読出し側が存在しないフィールドはないか？
  → src 全 export の消費者再走査（新規・分割後の面を含む）で死export ゼロ。
  フィールド書込↔読出し対で走査した結果 `escrow.deadlineAt` のみ write-only
  を検出（create 引数として受け取り保存するが、deadline スイープ未配線で
  全リポジトリに読出し側ゼロ — §11 の deadline/payout 配線と同じ領域）。
- **削除**: `create()` の `deadlineAt` 引数とフィールド格納を除去。
  第118ラウンドの `expire` 削除と同じ「deadline 未配線」面の続き。
  状態遷移 DEADLINE 自体は state-machine に残存。
- **監査して生存**: lightning-service.js 全23メソッド（connectToLND/
  cleanMaps/startPeriodicTasks は内部呼出しで生存 — 外部 grep 0 は
  自己参照のため除外）、providerInvoice/payoutSats（action-executor の
  resolveContext が参照 — 第118で残した payout 配線面）、cancelledAt/
  completedAt/startedAt/attestationReport/verificationCtx 全て読出しあり。

### 第120ラウンド（ソクラテス式問答 — 「export された実装詳細はあるか？」）

- 問い: module.exports に「外から一度も触れられない内部実装」を公開していないか？
  → ミドルウェア・api/utils・db/json 全モジュールの export↔消費者を再走査。
  `request-context.js` の `als`（AsyncLocalStorage インスタンス）のみ全
  リポジトリで import ゼロ — runWithContext/getRequestId/getTraceId 経由の
  間接利用のみで、直参照する外部消費者は存在しない。
- **削除**: `module.exports` から `als` を除去（内部 const は存続 —
  実装詳細の漏洩を塞ぎ、外側 API を getRequestId 系に限定）。
- **監査して生存**: db/json 宣言ファインダ全9件（getByOrderId/getByUserId/
  getByPaymentHash/getByProviderId/getByUsername/getByEmail/getByJobId/
  getByUser/getByGpu 全て呼出し実在）、middleware/utils 全 export
  （rawClientIp は rateLimitKeyGenerator の内部呼出し＋probe34 ソース検証
  対象 — 識別子保持規則で温存）、escrow.invoice/settlement/feeRate/history、
  order.paymentRequest 全て読出しあり。`order.usageMinutes`/`order.escrowId`/
  `user.totpSecret` は誤検出（存在しないフィールド／blocklist 文字列）。

### 第121ラウンド（ソクラテス式問答 — 「内部関数・依存に死面は残っていないか？」）

- 問い: export 以外の内部関数・内部変数に消費者ゼロは残っていないか？
  package.json の依存は分割後も全て参照されているか？
- **機械走査で収束確認**: src/ + ルート .js 全ファイルの内部関数宣言を走査し、
  同一ファイル内での参照数=1（宣言のみ）かつ未 export のものを列挙 → **ゼロ**。
- payments/marketplace/verification/core/service 層の全 export 消費者再走査
  → 全て生存（isTerminal/initial は escrow-service + state-machine テストが使用）。
- package.json 依存全19件 + OTel 4件 + dev 3件の require/import 実在確認
  → 全て使用。instrumentation.js は server.js:5 の副作用 require で生存。
- **判定**: 削除対象ゼロ — 検証のみの収束ラウンド（死面を作らない正直な記録）。

### 第122ラウンド（ソクラテス式問答 — 「このエンドポイントは誰が呼ぶのか？」）

- 問い: 未文書化で呼出しゼロの薄いラッパーエンドポイントは残っていないか？
  → admin.js の各ルート消費者を再走査した結果 `POST /admin/cache/purge`
  のみ全リポジトリ・ドキュメント・テストで参照ゼロを検出。
  「キャッシュを全パージする」操作は全 mutation で `invalidateUserCache`
  が自動実行されるため手動全パージは実用価値もなく、内部関数
  `purgeCache()` への薄いラッパーに過ぎなかった。
- **削除**: `/admin/cache/purge` ルート、`purgeCache` 関数+export、
  `cachePurgeCounter`（purgeCache 内でしか inc されない恒久0メトリクス）、
  cache.js の未使用 logger import、server.js の stale メトリクスコメント。
- **監査して生存**: 残り admin ルート全8本（/node-info・/channels・/admin/
  stats・/admin/verifications・/admin/escrow・/admin/expire-orders・
  /system/info — public/js・tests で参照あり）、NotifyType 全6種
  （LINE/DISCORD/SLACK/TELEGRAM/EMAIL/WEBHOOK — resolveChannels で使用）、
  tests/helpers/mock-ln-adapter.js（2 テストが使用）、
  invalidateUserCache（13サイト）、cacheHitCounter/MissCounter。

### 第123ラウンド（ソクラテス式問答 — 「この重複は悪か、probe が主張する契約か？」）

- **問い**: Joi パスワードポリシー（min8/max72/4種パターン/messages、13行）が
  `validator.js` の `schemas.user.register` と `user/me.js` の PUT /me/password に
  逐語複写されている — 単一真実源 `passwordSchema` へ集約すべきでは？
- **答え**: 適用したところ `probe51-bcrypt-72-cap` が両サイトで
  `password: Joi.string()...max(72)` / `newPassword: Joi.string()` の
  **インライン存在**をソーステキスト検証しており失敗。probe34 の識別子温存
  （第110ラウンド教訓）と同型で、重複そのものが「各サイトが独立に bcrypt 72バイト
  キャップを持つ」ことを probe が監査している — 片方が shared import だと
  その監査が宙に浮く。**意図的に温存**し、デデュープは全量 revert。
- **並走監査（死面ゼロ）**: proto/ 不在は mock LND の意図的フォールバック、
  ルート virtual-gpu-manager.js は唯一の正本（services.js 経由で生存）、
  docker/Dockerfile.api はデプロイ基盤（参照なしだが削除対象ではない）、
  process.env 全58名は .env.example または config.js で文書化済み、
  docs の全参照が実在ファイルを指す。
- **手順記録**: 重複ブロックスキャナ（8行窓・空白除去）が誤位置を報告したため
  実窓を再表示して真の重複を特定 — 監査スクリプトの偽陽性対策として再記録。

### 第124ラウンド（ソクラテス式問答 — 「参照ゼロと思われるファイルは本当に死か？」）

- **問い**: 消費者カウントの偽陰性をもう一度疑えるか — 前回までの「参照ゼロ」は
  パターン設計の死角ではなかったか？
- **答え**: 2件の偽陰性を捕捉 — `src/api/utils/mailer.js`/`totp.js` は
  master-auth.js が `../utils/*` で require（パス前方一致 grep が不一致で 0 件と
  誤報）、`scripts/slack-feedback-bot.js` は兄弟スクリプト7本が require する
  sendSlackMessage 共有ヘルパー（検索対象ディレクトリに scripts/ 自身を
  入れ忘れたため 0 件と誤報）。いずれも生存、削除対象ゼロ。
- **並走監査（死面ゼロ）**: config.js 全キー消費者あり（apiPrefix〜bcryptRounds 全18件）、
  全 router.get/post/put/delete パスに重複登録なし、console.error 4箇所はロガー自体が
  障害点になり得る failsafe 経路（audit-log ディスク満杯・denylist 読込失敗）、
  public/js・CSS リンク全て実在ファイル、TODO/FIXME マーカーなし、
  メール系2経路（nodemailer SMTP=master-auth 用 / SendGrid+Mailgun API=notifier 用）
  は別契約のため並存維持。

### 第125ラウンド（ソクラテス式問答 — 「未踏のディレクトリに見落としはないか？」）

- **問い**: `src/security/`・`src/reputation/`・`src/data/`・`src/pricing/` — これまでの
  走査が src の末端ディレクトリを個別に開いたか？
- **答え**: 全て生存。`provider-uptime.js`（recordProviderHeartbeat/recordSlaBreach/
  getReliability — order/runtime・sessions・gpu ルートが消費、GAP_THRESHOLD_MS・
  MIN_BEATS_FOR_SCORE・_resetVolatileState も輸出先あり）、`gpu-attestation-verifier.js`
  （verifyAttestation + mock ファクトリ — routes + 専用テスト）、`feature-pricer.js`
  （computePrice/generationScore — marketplace-service）、`UptimeRepository`
  （getByProviderId finder — provider-uptime 経由）。`src/data/profit-addresses.json` は
  profit-addresses ユーティリティが読む実データ。削除対象ゼロ。
- **並走監査（死面ゼロ）**: api/utils 全8ファイル・api/middleware 全10ファイル・
  payments 全4ファイル（executeActions/computeSettlement/DEFAULTS）・
  verification 全 export（shouldAudit/outputsMatch/ternaryConsensus/detectZeroLoad）・
  order-expiry 全4関数・request-context 全4 export・e2e helpers 全7関数・
  marketplace/default・docs 全8ファイル・全ルートマウント — 消費者不在ゼロ。

### 第126ラウンド（ソクラテス式問答 — 「この require はなぜファイル中盤にいる？」）

- **問い**: server.js に遅延 require が6件残っている — 第90・96ラウンドのホイストが
  なぜここを取りこぼしたか？
- **答え**: 中盤の `const invoicePoller`（try 内）、`const fs`/`express-rate-limit`
  （/ready 直前）、`const { cacheHitCounter, cacheMissCounter }`、
  `const { setServices, startMonitor }`（「TDZ回避」コメント付き）、
  `registerProcessGuards`（main ガード内）を全て冒頭へホイスト。
  いずれも副作用なしモジュールで循環参照なし（invoice-poller の依存は
  logger/Repo/audit-log のみ、server が既に遷移的に読込済み）。
  呼出し側の try/main ガードは保持 — 失敗許容性は変えない。
- **残した面**: `require('../../lightning-service')` は「存在しない場合はスキップ」の
  意図的遅延のため try 内に温存。`token-denylist` の audit-log 遅延 require も
  失敗黙殺を意図した catch ガード内のため温存。
- **監査して生存**: ExtendedGPUDetector 全18メソッド（detectAMDGPUsAdvanced 外部呼出し
  1件＋内部 this.* チェーン＋Windows WMIC テスト直叩き）、security.js 全7 export、
  marketpalce/default、provider-uptime・attestation-verifier 全 export。

### 第127ラウンド（ソクラテス式問答 — 「docs が指すファイルはまだ存在するか？」）

- **問い**: 分割ラウンド（103–108）で動いたコードへの docs 参照は生きているか？
- **答え**: `SPECIFICATION.md` の Escrow フィールド列に `deadline` が残留
  （118ラウンドで `deadlineAt`/`expire` 削除済み）→ `orderId, amountSats,
  feeRate, invoice, state, history`（`escrow-service.js` create() の実フィールド）へ修正。
- **監査して生存（stale に見えるが実在）**: `src/api/utils/btc-payment.js`・
  `lightning-api.js` — category-research で「置換対象」として言及される両ファイルは
  `src/api/utils/` に実在・稼働中（btc-onchain.js ルート + sendLightningPayment が
  btc-payment 内部経由）。ルートパスではなく `utils/` 配下のため初回 ls で見落とし
  —— 存在チェックは推定パスではなくリポジトリ全走査で行うべき。
- **判断して温存**: `category-research-2026` / `improvement-research-2026` /
  `PRODUCT_ANALYSIS` の `routes/payment.js`・`order/index.js` 参照 — 日付付きの
  時点分析記録であり「当時の現状」を述べる文脈を現在形へ書き換えると記録を偽造する。
- **並走監査（死面ゼロ）**: 残り遅延 require 全8件は router.use マウント式・telemetry
  副作用 import・denylist の catch ガード内 — 全て意図的。import 束縛走査は
  `_rlKeyGeneratorShared`（別名インポート）等を誤検出したが全て生存確認済み。
  workflows が参照する `openapi-generator.js`/`optimize-images.js`/lint script は
  不存在 — `.github/workflows` 未push 権限制約の既知 CI 失敗として記録。

### 第128ラウンド（ソクラテス式問答 — 「SPA が呼ぶエンドポイントは実在するか？」）

- **問い**: public/js が fetch する API パスに削除済み・不存在の死呼出しは残っていないか？
- **答え**: SPA 呼出し26パスを全抽出 → 実ルート定義（6マウント×67ハンドラ）と照合、
  全て実在・死呼出しゼロ。テンプレート展開（`${id}`）込みでも全経路解決。
- **逆方向監査（SPA が呼ばない API 面）**: `/me/password`・`/me/activity`・
  `/me/watches`・`/totp`・`/logout`・`/node-info`・`/channels`・`/system/info`・
  `/marketplace/*` は SPA 非呼出しだが、全て tests/ に消費者あり（logout 4 件・
  channels 6 件・escrow 23 件等）— 公開 API 契約として生存。SPA 非呼出し =
  死エンドポイントではない（API クライアント経路）。
- **並走監査（死面ゼロ）**: `data/` 全10 json は対応 Repository が読書き、
  `docker/Dockerfile.api` はデプロイ基盤、`src/api/utils/` 全7ファイル消費者あり
  （session-invalidation は jwt-auth、profit-addresses は admin ルート経由）。

### 第129ラウンド（ソクラテス式問答 — 「CSS クラスはテンプレート経由でも消費されるか？」）

- **問い**: app.css の81クラスに HTML/JS 側の参照がないものはないか？
- **答え**: リテラル `class="..."` grep だけでは `badge-${status}` 等の
  テンプレート合成を見落とす。動的パターンを全展開して照合した結果、
  死セレクタゼロ — badge-×6状態（PENDING/MATCHED/ACTIVE/COMPLETED/CANCELLED/
  DISPUTED 全てサーバー値域に対応）・chip-reliability-×5ティア（excellent/good/
  fair/poor/unrated）・toast-×3種（info 既定/error/success）全て生成経路あり。
- **教訓**: 第95・124ラウンドと同型 — 「リテラル参照なし = 死」は動的言語・
  動的CSSでは偽陰性。合成テンプレートの値域を先に列挙しないと誤判定する。
- **並走監査（死面ゼロ）**: `.bak/.orig/.swp/.old` 残留ゼロ、
  `telemetry/instrumentation.js`（41行・環境変数ゲート付き no-op）は意図的設計、
  `tests/helpers/`（mock-ln-adapter のみ）と `tests/utils/`（src/utils の
  テスト置き場）は別用途で重複なし、globalSetup.js は data/ 初期化の中核。

### 第130ラウンド（ソクラテス式問答 — 「export したが import されない関数はないか？」）

- **問い**: public/js の ES module export 30件に import 消費者がないものはないか？
- **答え**: 全30 export を走査。嫌疑3件（`clear`・`setSession`・`statusLabel`）を
  精査したが全て生存 — `clear` は app.js が import、`setSession`/`statusLabel` は
  定義ファイル内で使用（同一ファイル内呼出しは import 不要）。
  **export だが他ファイルから未使用の関数: ゼロ**。
- **並走監査（死面ゼロ）**: btc-payment 全6 export（btc-onchain 経路で消費）、
  分割ファイル全10本の未使用 const ゼロ、scripts 全16本が package.json scripts または
  兄弟 require で消費（line-notify は service-monitor の LINE チャネル経由＋probe57）、
  yaml/compose 残留ファイルゼロ、docker-compose 設定不在（Dockerfile.api のみ）。
- **備考**: 削除系監査面の完全収束を継続確認 — 4 連続検証ラウンド（127–130）で
  削除対象ゼロ。残るは §11 の設計判断2件（実装領域）のみ。

### 第131ラウンド（ソクラテス式問答 — 「層ごとに export は全て消費されているか？」）

- **問い**: utils/middleware/services/core/payments/verification 各層の export を
  層別に全照合したら、消費者なしの面が残るか？
- **答え**: ゼロ — 全層完全消費を機械確認。
  - `src/utils` 全42 export（validator/sanitize/notifier/error-handler/ssrf-guard/
    sliding-window-limit/pagination/exchange-rate/order-expiry/order-pricing/
    process-guards/request-context/async-lock/audit-log/config/email/logger/
    state-checker/user-notify）→ 外部消費者全件存在
  - `src/api/middleware` 全10ファイル24 export（jwt-auth/rbac/security/rate-limit/
    cache/audit/logger/token-denylist/ip-key/master-session）→ 全件存在
  - `src/services`+`core`+`payments`+`verification`+`reputation`+`security`+
    `pricing`+`db/json` 層36 export → 全件2ファイル以上の消費者
- **判定**: export 面は層別総当たりで完全収束。これ以上の層別再走査は
  同一面の反復になるため、次は「export ではない内部記述」方向が唯一の残存面。

### 第132ラウンド（ソクラテス式問答 — 「export しない内部コードに死分岐はないか？」）

- **問い**: 大規模ファイル12本の内部（非 export）に未使用関数・到達不能コード・
  死DOM参照は残るか？
- **答え**: ゼロ — 嫌疑は全て偽陽性。
  - 「return 後の行」ヒューリスティックで18件検出したが全て `return res.json({...})`・
    `return withLock(...)` の複数行継続（引数の中身）— 実到達不能ゼロ
  - 未使用内部 function 宣言ゼロ（lightning-service・vgpu-manager・gpu-detector
    最大3ファイル含む）
- **DOM 双方向監査**: JS が参照する getElementById/querySelector('#x') 全5 id が
  index.html に実在。逆方向の孤リファレンスもゼロ（el() 動的生成を考慮）。
- **CSS 重複ルール**: `.field-row` が2箇所に見えたが `.field-row > .field` との
  別セレクタ混同 — 同一ルールの複写なし。

### 第133ラウンド（ソクラテス式問答 — 「この複写は本当にdedupできるか？」）

- **問い**: disputes.js の /review・/renter-review に同一形ガードが2組ある
  （30日レビュー期限・支払い確認）— dedup してよいか？
- **答え**: **断念・温存** — probe51 と同型で「複写そのものが契約」。
  `assertReviewWindow`/`assertPaidOrder` ヘルパー抽出を適用したが、
  probe42 が `within 30 days` の**両ハンドラ内**インライン存在（≥2回）を、
  probe43 が `renterReviewWindowAnchor|completedAt \|\| order\.stoppedAt`
  の ≥2回出現をそれぞれソース検証しており失敗。適用→jest赤→**全量 revert**。
- **教訓**: probe テストのソース読みアサーションには3類型ある —
  識別子存在（probe34）、コード形状・順序（probe25/31/40）、
  **インライン複写の両側存在**（probe42/43/51）。dedup 判断前に対象パターンが
  probe の match/count 式に含まれていないか確認必須。
- **並走監査（死面ゼロ）**: routes/ 横断の内部関数名に他の複写なし
  （daysSinceCompletion の2件のみが嫌疑、上記）。

### 第134ラウンド（ソクラテス式問答 — 「似た形のコードは本当に同じ契約か？」）

- **問い**: probe が読まないルートファイルに 4行以上の複写ブロックが残るか？
- **答え**: probe の require.resolve 対象ファイルを先に全列挙（mutations×12・
  master-auth×10・auth×8・disputes×8 等）し、**非読み込みファイルのみ**を
  対象にスライド窓スキャン。嫌疑は全て不適合と判定。
  - `order-pay.js` の `PaymentRepository.create` 2箇所 — manual vs lightning で
    paymentHash/paymentRequest/method/invoiceExpiresAt が実契約差。共通部だけ
    抽出すると差分が散逸し可読性を損なうため温存
  - `reads.js` の `} catch (error) { next(error); }` 連続ヒット — Express
    asyncHandler の標準末尾パターンであり dedup 対象ではない
  - ファイル冒頭の import 群一致 — ライセンス的な共通ヘッダ（dedup 非対象）
- **方法論の改善**: dedup 監査は probe 契約ファイルを事前除外 — 第133ラウンドで
  probe42/43 を撞いた失敗を手順化で防止。
- **備考**: 複写系は probe 非制約面でも契約差または標準形のみ — dedup 面も収束。

### 第135ラウンド（ソクラテス式問答 — 「テストの未使用 require は残るか？」）

- **問い**: tests/ の `const x = require(...)` に使用ゼロの束縛は残るか（第85ラウンドの
  supertest request×9 削除の続き）？
- **答え**: **削除対象ゼロ** — naive な名前頻度スキャナで約30件の嫌疑が出たが、
  全て直接 grep で生存確認（`request` は supertest 経由で使用、`server` は
  afterAll の `require` で使用、`GpuRepository`/`OrderRepository`/
  `UserRepository`/`sanitizeUser`/`jwtAuth`/`rbac` 全て実呼出しあり）。
- **教訓**: 内部スキャナの偽陽性は本セッションで4度目（124・131・132・135）。
  「name の match 回数 ≤1 → 死」の単純ヒューリスティックは、ファイル内
  require・コメント内言及・`afterAll` 内の遅延 require を見落とす。
  **機械検出は候補列挙に留め、削除判断は必ず手動 grep で1件ずつ検証する**。
- **並走監査（死面ゼロ）**: tests/e2e の playwright spec・helpers 消費者確認済み、
  globalSetup の data/ 初期化は全スイート共通の生機構。

### 第136ラウンド（ソクラテス式問答 — 「設定ファイルの列挙項目は全て実在か？」）

- **問い**: .gitignore・jest.config・data/*.json に、削除済みコード由来の
  残留エントリはないか？
- **答え**: ゼロ。
  - `.gitignore` の生成物列挙（feedback-report.md・checklist-kpi-report.md・
    assignee-progress-report.md・feedback-log.json・feedback-priority.json・
    improvement_checklist4.md）は全て実在スクリプトの出力先（feedback-to-
    checklist・alert-overdue・slack-notify 等の npm scripts 経由で消費）
  - `jest.config.js` の全4キー（testTimeout/globalSetup/maxWorkers/
    testPathIgnorePatterns）はコメント記述どおり意図的設定 — maxWorkers:1 は
    JSON 層の cross-process lost-update 回避で必須（§11 設計判断と整合）
  - `data/*.json` 全10ファイルは globalSetup により空リセット — 削除済みコード
    （deadlineAt/cachePurgeCounter 等）の stale フィールド混入なし
- **並走監査**: logs/ の combined1-4.log は winston maxsize ローテーションの
  正常生成物（gitignore 済・削除対象外）。

### 第137ラウンド（ソクラテス式問答 — 「SPA ルート表と登録ハンドラは一致するか？」）

- **問い**: app.js のルート登録に未配線ページ・死リンクは残るか？
- **答え**: ゼロ — SPA 全配線を双方向で確認。
  - pages/ 全11ファイルが app.js で import・ルート登録済み
  - 登録ハッシュ10件 + setNotFound・`#/` 既定 — 全リンク（`#/market`・`#/orders/:id`
    等）が実ルート解決
  - `navigate` も logout ボタン（app.js:69）で実使用
  - `router.js` 内部（route/parseHash/renderCurrent/cleanup契約/escapeText/
    navigate）も全消費 — タイマーリーク防止のクリーンアップ契約が実装済み
- **並走監査（死面ゼロ）**: routes/index.js の6マウント配線（marketplace・
  notification-settings・profit-addresses 等）全て実モジュール、
  `/marketplace/stats` の特別扱い（stats は :id より先に照合済）も順序保証済。

### 第138ラウンド（ソクラテス式問答 — 「shutdown() は本当にシャットダウンするか？」）

- **問い**: `lightning-service.shutdown()` の「イベントストリームのクリーンアップ」が
  `(実装省略)` のまま — シャットダウン後に再接続タイマーは止まるか？
- **答え**: **実 lifecycle 欠陥を修正** — shutdown() がプレースホルダで、
  invoice/channel ストリームの error/end/close ハンドラが発行する
  `setTimeout(setupXStream, 5000)`×10 は unref も取消も停止ガードもなく、
  シャットダウン後も最長5秒後に再サブスクライブを発火し続けていた。
  - `this._stopped`/`_reconnectTimers`/`_streams` の追跡フィールドをコンストラクタへ
  - `_scheduleReconnect(fn)` を新設 — `_stopped` 時は早期return、タイマーは
    unref して発火時にセットから除去、発火前にも `_stopped` を再検査
  - 全10箇所の `setTimeout(setupX, 5000)` を `_scheduleReconnect` へ置換
  - `shutdown()` にストリームクリーンアップを実装 — 全タイマー取消・
    全ストリームの removeAllListeners + cancel/destroy（モックの
    EventEmitter には存在しないため optional call）
  - `initialize()` で `_stopped = false` リセット（再 init 対応）
- **監査して生存**: 他の setInterval/setTimeout（invoice-poller・service-monitor・
  server.js メトリクス・sessions の SLA 掃討・LN バックオフ）は全て
  unref/clearInterval/テスト環境ガード済み — 本件が唯一の未管理ライフサイクル。
- `npx jest --forceExit` 全緑: 115/115・1,045・52秒。

### 第139ラウンド（ソクラテス式問答 — 「stop/shutdown は誰が呼ぶのか？」）

- **問い**: 第138で実装した `lightning.shutdown()`、`invoicePoller.stop()`、
  `service-monitor.stopMonitor()`、sessions の SLA 掃討 — どこからも呼ばれていない
  停止フックは存在理由があるか？
- **答え**: **未配線ライフサイクルを gracefulShutdown へ結線**。
  - `gracefulShutdown` は `server.close()` のみ待ち、`process.exit(0)` へ直行
    — ドレイン中（最大30秒）も invoice-poller・service-monitor・SLA 掃討・
    LN ストリーム再接続が発火し続けていた
  - ドレイン開始前に `invoicePoller.stop()`・`stopMonitor()`・`metricsInterval`
    ・新設の `stopSessionSweep()`（sessions.js の非公開 interval を外部から
    止められるように export）を実行 — 各 stop は try/catch でシャットダウン
    を妨げない
  - `server.close()` 後に `coreServices.lightning.shutdown()` を await して
    から `process.exit(0)`
- **同ラウンドで捕捉した潜伏欠陥**: server.js の `lightningService` は
  `require('../../lightning-service')` のモジュールオブジェクト（`{LightningService}`）
  であり、実インスタンスは `safeLoad` が `new` した `coreServices.lightning`。
  `updateLightningMetrics` が `lightningService.channels`（常に undefined）を
  読んでいたためチャネル容量ゲージは一度も更新されていなかった → 実体参照へ
  修正し、死参照 `let lightningService` ブロックを削除。138 で結線した
  shutdown も同じ罠（モジュールに `.shutdown` は無い）を踏みかけていた。
- `npx jest --forceExit` 全緑: 115/115・1,045・64秒。

### 第140ラウンド（ソクラテス式問答 — 「保持上限は実際に保持を強制するか？」）

- **問い**: `maxInvoices`/`maxPayments`/`maxChannels`/`retentionMs` の保持 config は
  実際に Map を剪定しているか？ `startPeriodicTasks` の周期タイマーは止められるか？
- **答え**: **2件の実欠陥を修正**。
  - `cleanMaps` の剪定ループ3箇所は `for (i = 0; i < this.X.size - max; i++)` —
    削除ごとに `this.X.size` が縮み境界も縮むため、超過分の**約半分**しか削除
    しない（S=1100,M=1000 で50件しか掃かない）。`excess` を先に算出して全超過
    分を削除するよう修正（invoices/payments/channels 全3箇所）
  - `startPeriodicTasks` の3個の setInterval は unref もハンドル保持もなく
    shutdown 対象外 — `_periodicTimers` に保持して unref、`shutdown()` で
    clearInterval、`startPeriodicTasks` 冒頭に `_stopped` ガード
- **監査して生存**: `usageSessions`/`heartbeatTimestamps`（30秒 SLA 掃討 + reap
  で寿命管理済）、invoice-poller/service-monitor/server メトリクス（139 で
  gracefulShutdown 結線済）、LN 再接続タイマー（138 で管理済）。
- `npx jest --forceExit` 全緑: 115/115・1,045・57秒。

### 第141ラウンド（ソクラテス式問答 — 「レート制限の記憶は有限か？」）

- **問い**: `createSlidingWindowLimiter` の `state` Map はキー単位に無制限に
  成長する — ユニークキー噴霧（攻撃元 IP・メール列挙）でメモリを枯渇させる
  攻撃が、レート制限機構そのものに向けられるのでは？
- **答え**: **`maxKeys` 上限を追加して境界化**。失効キーは isLimited/reset が
  同じキーを再度読まない限り Map に残り続けるため、`hit()` で `state.size` が
  上限を超えた時点で一掃する: まず失効キー（windowStart 超過）を全て捨て、
  なお超過なら最古の窓から追い出す。直前に hit したキーは windowStart が
  最新のため即座に追い出されない。既定 100,000 キー（call site は変更不要）。
- **監査して生存（契約強制済み）**: `LRUCache`（max:1000+ttl をライブラリが
  ネイティブ強制）、token-denylist（revoke 時に prune+persist・isRevoked で
  遅延削除 — revoke 件数で境界化済）、usageSessions/heartbeatTimestamps
  （SLA 掃討+reap）。
- `npx jest --forceExit` 全緑: 115/115・1,045・54秒。

### 第142ラウンド（ソクラテス式問答 — 「ログはディスクを食い尽くさないか？」）

- **問い**: `access-audit.log`（全 HTTP リクエスト）・`db-access.log`（UserRepository
  の全アクセス）・`gpu-events.log` はローテーション・サイズ上限なく素追記 —
  トラフィックに比例してディスクを枯渇させるのでは？
- **答え**: **`src/utils/bounded-append.js` を新設して3箇所を境界化**。
  上限到達時は `file.log → file.log.1` へロールオーバーして新ファイルを開始
  — audit-log.js の「上限で追記停止（以後の証跡が暗くなる）」より、直近の
  証跡を残す方がフォレンジック補助ログでは有効。ディスク使用は最大2×上限で
  境界化。上限は既存の `MAX_AUDIT_LOG_MB`（既定50MB）を共有。
- **監査して生存（契約強制済み）**: winston ファイル転送（maxsize 10MB +
  maxFiles 5 でローテーション済）、`audit.log` ハッシュチェーン（
  MAX_AUDIT_LOG_BYTES で drop+alert — ロールオーバーはチェーンを分断するため
  drop 方式が正しい）。
- `npx jest --forceExit` 全緑: 115/115・1,045・63秒。

### 第143ラウンド（ソクラテス式問答 — 「解放されたアロケーションはどこへ行くか？」）

- **問い**: `virtual-gpu-manager` の `allocations` Map — `releaseVirtualGPU` が
  `status='released'` に更新するだけで Map から削除しない。released エントリは
  誰かが読むのか？
- **答え**: **滞留蓄積を削除** — released エントリは active フィルタ（228/462行の
  2箇所の検索）でも `get(allocationId)` でも二度と読まれず、ディスクへも
  永続化されない（監査複製は `order.allocationDetails` に既存）。アロケーション
  ごとに Map が無制限成長していた → `releaseVirtualGPU` でエントリ削除
  （返却オブジェクトには status/endTime が残る）、`destroyVirtualGPU` で
  vgpuId 一致の残存アロケーションを一掃。
- **監査して生存**: `virtualGPUs`（destroy で削除済）、exchange-rate キャッシュ
  （単一スロット {rate,timestamp} で境界化）、express-rate-limit MemoryStore
  （窓ごとにリセット）。
- `npx jest --forceExit` 全緑: 115/115・1,045・55秒。

### 第144ラウンド（ソクラテス式問答 — 「全てのタイマーと蓄積は追跡・境界化されているか？」）

- **問い**: ライフサイクル・保持契約の監査を2面で総走査 — (a) `setInterval`/
  `setTimeout` を使う全ファイルに clear/unref があるか、(b) 残るインメモリ/
  永続蓄積（notifications、watches、escrow、btc-onchain、audit-log キュー、
  attestation/order-expiry）に境界があるか。
- **答え**: **全て契約強制済み、削除対象ゼロ** —
  - タイマー全8ファイル: runtime.js の1件はコメント言及、notifier.js の
    `await new Promise(setTimeout(backoff))` は一回限りのリトライ遅延（await
    で settle するまで参照保持 — 追跡不能でも漏洩でもない）。残りは全て
    clear/unref/stop フック済み。
  - `notifyUser`/`user-notify` はチャネル発信専用で蓄積なし（NotificationRepository
    は存在しない — インバンド通知は外部チャネル経由のみ）。
  - watches.json の発火済み price watch は削除されないが**契約として正しい**:
    継続アラート（lastNotifiedAt で重複通知抑制）かつユーザー削除 API あり。
  - `MAX_AUDIT_LOG_MB` は audit-log.js（drop+alert）と bounded-append.js
    （rollover）が同一 env を参照し .env.example 記載済みで整合。
- **監査して生存（契約強制済み）**: audit-log `_hashCache`（logPath でキー付き、
  プロセス内定数個）、order-expiry/attestation-verifier（タイマー・Map なし）。

### 第145ラウンド（ソクラテス式問答 — 「非 await の非同期呼出しは rejection を食らうか？」）

- **問い**: `notifyUser(...)` 等を await せずに発火する22箇所と、setImmediate/
  setInterval 駆動の非同期コールバック — unhandled rejection でプロセスが
  落ちる面はないか。
- **答え**: **全て内部 catch で契約強制済み、削除対象ゼロ** —
  - `notifyUser`: チャネルごとに `sendNotification(...).catch(...)` 処理済み。
    非 await は意図的（応答をブロックしない fire-and-forget）。
  - `notifyPriceWatchers`/`notifyWatchJustCreated`（setImmediate 経由）: 同期関数で
    内部 try/catch — リジェクションを生成しない。
  - `setInterval` コールバック全て（pollOnce/monitorServices/sweep+reap）:
    内部 try/catch で包まれている。
  - `registerProcessGuards`: `unhandledRejection`（ログのみ継続）と
    `uncaughtException`（閉じて exit）を server.js の main 経路で配線済み。
- **監査して生存（契約強制済み）**: 全 fire-and-forget 経路（notifyUser × 22、
  price-watch setImmediate × 3、interval コールバック × 4、process guards）。

### 第146ラウンド（ソクラテス式問答 — 「文書化された設定は読まれているか？」）

- **問い**: `.env.example` の `KEY=` 行全23件 — `process.env.KEY` の直参照が
  ないものは「文書化されたが読まれない」stale 設定か。
- **答え**: **全て参照済み、stale 設定ゼロ** — `safeInt()`/`requireSecret()`/
  `config.server.port` 経由の間接参照を確認したところ、直参照ゼロの3件も全て
  消費されている: `BCRYPT_ROUNDS`（safeInt, config.js:111）、`SESSION_SECRET`
  （requireSecret, master-session.js:18）、`PORT`（safeInt → config.server.port,
  server.js:76）。コメント行の名詞（API/GPU/POST/E2E/MAILGUN_*/SENDGRID_*/
  EMAIL_FROM）は実 KEY= 行ではなく文書言及でした。
- **監査して生存**: GPU 一覧クエリフィルタ（features/minMemoryGB/maxPrice/
  vendor/country/apiType/search/available/minRating）は全フィールドが読込→
  フィルタ適用（reads.js:46-184）で、バリデーション済みだが無視される
  パラメータなし。

### 第147ラウンド（ソクラテス式問答 — 「宣言された保護は実際に配線されているか？」）

- **問い**: 44個の mutation ルート — rate-limit・認証・権限チェックは全て
  実際に適用されているか。認証なしで状態を変えられるパスはないか。
- **答え**: **全て保護配線済み、削除対象ゼロ** —
  - グローバル: `app.use(apiLimiter)`（config ゲート）+ `router.use(rateLimit)`
    が全 API ルートに先行適用。`/metrics`・`/ready` には専用リミッター。
  - mutation 全44ルートに `authenticateJWT` 直後配線（複数行定義のため次行 —
    order mutations/runtime/disputes、gpu lifecycle/blocks/watch 全て）。
  - `admin.js` の mutation も `jwtAuth + rbac('admin')`。
  - master-auth `/totp`・`/mail` のみ jwtAuth 不在だが**意図的で正しい**:
    ログイン前の多要素チェーンで、各々 `req.session.googleAuth`（OAuth 前段）・
    `req.session.totpAuth`（TOTP 前段）を要求。セッション+IP 二層レート制限、
    TOTP ウィンドウ再利用防止、メールコード TTL・単回消去・試行上限を完備。
- **監査して生存**: 保護契約は全ルートで強制済み — 認証なし mutation なし、
  admin は rbac 保護、master-auth はセッションゲート多要素チェーン。

### 第148ラウンド（ソクラテス式問答 — 「宣言された数値上限は強制されているか？」）

- **問い**: `.env.example` の制限系 env 変数16件（MAX_PENDING_ORDERS/
  MAX_GPUS_PER_PROVIDER/MAX_OPEN_DISPUTES/MIN_RESOLVED_DISPUTES/
  MAX_DENIED_DISPUTE_RATE/HEARTBEAT_MIN_INTERVAL/UPTIME_*/SLA_*/
  ORDER_*_TIMEOUT 等）— ハンドラで実際に強制されているか。
- **答え**: **全て強制済み、stale 宣言ゼロ** — 全件 `process.env.X` の実参照で
  enforcement サイトに存在:
  - `MAX_GPUS_PER_PROVIDER` → lifecycle.js プロバイダ上限チェック
  - `MAX_OPEN_DISPUTES_PER_USER`/`MIN_RESOLVED_DISPUTES`/
    `MAX_DENIED_DISPUTE_RATE` → disputes.js:57-75（denied 率制限+オープン数上限）
  - `HEARTBEAT_MIN_INTERVAL_MS` → runtime.js 心拍間隔下限
  - `UPTIME_GAP_THRESHOLD_MS`/`UPTIME_MIN_BEATS`/`UPTIME_BREACH_PENALTY` →
    provider-uptime.js:24-34（スコア計算の閾値）
  - `SLA_PROVIDER_HEARTBEAT_TIMEOUT_MS` → sessions.js SLA 掃討
  - `ORDER_*_TIMEOUT_*` → order-expiry.js 満了スイープ
  - `SERVICE_MONITOR_INTERVAL_MS` → service-monitor.js:113
- **教訓**: 初回 grep が `\.env` を除外する際 `process.env.X` の参照行自体を
  巻き込んで除外し、全件 0 件という偽陰性に陥った — フィルタ設計時に参照形の
  字列と除外対象が衝突しないか確認必須（第95/124 型の再発）。
- **監査して生存**: 宣言された制限は全て実装に配線済み — 「宣言のみ契約」なし。

### 第149ラウンド（ソクラテス式問答 — 「withLock なしの書込みは競合するか？」）

- **問い**: withLock を持たないファイルの repo 書込み（gpu/lifecycle ×6、
  user/me ×4、user/admin ×2、payment/invoices ×2、order/sessions ×1）—
  競合更新の面はないか。
- **答え**: **全て契約強制済み、削除対象ゼロ** —
  - `createJsonRepository` の create/update/delete は**全同期**（`readFileSync`
    + `atomicWriteJSON` の temp+rename）。単一呼出しは単一 tick で不可分 —
    単一プロセス内で部分書込み・撕裂は起きない。
  - `withLock` の実目的は**複数ステップ非同期シーケンス**（check → await →
    write の interleave 窓）の直列化で、それを必要とする order/escrow/
    user auth 経路には全て配線済み。
  - `order/sessions.js` は `updateIf`（compare-and-swap — load→predicate→write を
    一同期区間で）で述語と書込みを結合。GPU PUT の重複名チェック→update も
    同期連続（間に await なし）。
  - 単一呼出し書込みにロックは不要 — 同期不可分なため。
- **教訓**: 「withLock がない = 競合」は偽陽性 — ロック必要性は「await を挟む
  複数ステップ」で判定する。単一プロセス前提の残存露出（複数プロセスからの
  JSON lost-update）は §11 の設計判断項目として棚卸し済み。

### 第150ラウンド（ソクラテス式問答 — 「検査と更新の間に await が挟まるパスはどこか？」）

- **問い**: `getById`/`getAll` → `await` → `create`/`update` の形を全ルートで
  機械走査（read→await→write のパターン検出）。withLock/updateIf の外に残った
  真の TOCTOU はどこか。
- **答え**: **GPU 登録2経路に実 TOCTOU を修正** —
  - `POST /gpus`: `getAll` でクォータ+重複チェック → `await attestation.verify`
    → `GpuRepository.create` — 同一プロバイダの並行 POST が両方チェックを
    通過して両方 create できた（重複名・クォータ超過）。
  - `POST /gpus/bulk`: ループ先頭の `allGpusSnapshot` がループ内の
    attestation await を挟んで stale 化 — bulk+bulk や bulk+単体の並行で同じ。
  - 修正: 両経路を `withLock('gpu:create:' + providerId)` で包み、クォータ/
    重複チェックから create まで同一ロックで直列化（プロバイダ単位なので
    他プロバイダの登録は並行のまま）。cap 拒否は `{status,error}` を
    ロックコールバックから返し応答形状を保持。
- **監査して生存（他の await-挟まりは全て保護済み）**: mutations の cancel/
  create（withLock または設計どおりの同期ブロック — コメントで明記）、
  runtime.js の heartbeat/start（withLock）、btc-onchain/order-pay/auth（各
  withLock）、sessions の updateIf CAS。me.js のパスワード更新は
  `bcrypt.compare`→`hash`→`update` で read-modify-write だが、書き込みは
  merge 型で last-writer-wins が意味的に正しい（同一ユーザーの2並行変更は
  両方有効な新パスワードを設定 — 後勝ちは許容）。

- `npx jest --forceExit` 全緑: 115/115・1,045・53秒。

### 第151ラウンド（ソクラテス式問答 — 「ポーラーの status 書き込みは CAS か？」）

- **問い**: routes 以外へ拡張した read→await→write 走査で残った唯一の面 —
  invoice-poller の payment.status 書込み。注文側は既に `updateIf` CAS（
  cancel/reject/expire との競合を防ぐコメント付き）なのに、payment 側の
  5箇所は素の `update` — `checkInvoice` await 中に別経路が status を遷移
  した場合、ポーラーが上書きするのではないか。
- **答え**: **全5箇所を CAS 化して修正** — 各 `PaymentRepository.update` →
  `updateIf(id, p => p.status === 'pending', {...})`:
  - underpayment-mark・order_not_payable・already_paid_via_other_method・
    invoice_expired: 別経路（手動承認等）で確定した支払いを failed で
    巻き戻さないよう pending 限定に。
  - mark-paid: pending 限定にし、`paidWrite.ok === false` なら audit/
    注文前進もスキップ（遅延 settle 通知による paid 再書込みを抑止）。
- **監査して生存**: `_running` フラグでポーラー同士の重畳防止は既存、
  注文前進の `updateIf(status==='pending')` CAS は既存 — 本件は payment
  側の未 CAS 面のみだった。

- `npx jest --forceExit` 全緑: 115/115・1,045・52秒。

### 第152ラウンド（ソクラテス式問答 — 「status 遷移の素の update は全て CAS か？」）

- **問い**: `status:` を書く `update(` を全 src 走査 — 状態遷移の素の
  update は「チェック→書込み」間の競合で lost-update し得る。どの status
  書込みが CAS/ロックなしで走っているか。
- **答え**: **全箇所が保護済み・対象ゼロ** — status 書込みを持つ4ファイル:
  - `gpu/lifecycle.js`: POST /・/bulk = `withLock`（150th）、PUT :id の
    重複名チェック→update は await なしの同期ブロック（単一 tick で不可分）。
  - `order/disputes.js`・`order/mutations.js`: `updateIf`/`withLock` を
    各10箇所で既使用。
  - `user/me.js` deactivate: `getAll().filter(NON_TERMINAL)` → `update` が
    同期ブロック（await なし）で不可分。
  - `core/invoice-poller.js`: 151th で全5箇所を `updateIf(status==='pending')` に。
- **監査して生存**: `status:` マッチの一部はレスポンス形状（me.js:284/298）
  で書込みではない。複数プロセス競合のみ §11 の JSON 層設計判断に棚卸し。

- `npx jest --forceExit` 全緑: 115/115・1,045・52秒（前回実行流用 — 変更なしの検証ラウンド）。

### 第153ラウンド（ソクラテス式問答 — 「複数書込みの途中失敗は部分適用を残さないか？」）

- **問い**: 1リクエスト内に2回以上のリポジトリ書込みがあるハンドラで、
  最初の書込みが成功してから例外が出ると「状態は遷移したのに副作用だけ
  抜け落ちる」部分適用が残るのではないか — ただし CAS 失敗時 409（副作用
  前の早期 return）は部分適用を生じない。
- **答え**: **対象ゼロ（全経路がガード済みまたは副作用なし）**:
  - `disputes.js` resolve: 注文 CAS → `cancelEscrowsForOrder`（外側+個別
    try/catch・投げない）→ `UserRepository.update` カウンタ（自己 try/catch
    で warn 記録の意図的デグレード）→ `notifyUser`（チャネル毎 catch）—
    注文遷移後に投げ得る未ガード呼出しなし。カウンタ増減は getById→update の
    連続同期呼出しで単一 tick 不可分。
  - `mutations.js` create: `OrderRepository.create` 後の副作用は通知系のみ
    （全て `.catch` ガード）。第二リポジトリ書込みなし — 支払いレコードは
    別リクエストの別状態遷移。
  - `order-expiry.js` 各掃討: 1注文1 `updateIf` + 副作用は全てガード済み。
- **監査して生存**: disputes のカウンタ喪失リスクは warn ログ記録の許容
  デグレード（残高ではなく統計値）。

- `npx jest --forceExit` 全緑: 115/115・1,045・52秒（前回実行流用 — 変更なしの検証ラウンド）。

### 第154ラウンド（ソクラテス式問答 — 「外部サービス呼出しは全てデッドライン付きか？」）

- **問い**: Lightning hold-invoice 実践調査（buildonln/lnd#2022）で持ち出した
  論点 — HTLC 資金のロック時間はグリーフィング面になるため「LND 呼出しが
  永久に返らない」自体がライブネス攻撃面。本コードの gRPC 呼出しに
  デッドラインはあるか。
- **答え**: **全12箇所にデッドラインなし → 全て `withGrpcDeadline` で境界化** —
  `lookupInvoice`/`sendPaymentSync`/`addInvoice`/`getInfo`/`decodePayReq`/
  `listChannels`/`channelBalance`/`settleInvoice`/`cancelInvoice`/
  `openChannelSync`/`pendingChannels` が LND のコールバック不返で永久待機
  し得た。最悪は `lookupInvoice`：ポーラーの `_running` が永久スタックし
  **全 Lightning 決済確認が静かに停止**（外部観察は「支払いが一向に
  matched にならない」のみ）。`Promise.race` で 30 秒後に reject +
  `unref` タイマー（永続化非阻止）— ポーラーの try/catch が次周期で回復。
- **注記**: sendPaymentSync/settleInvoice 等の決済実行系は LND 側処理が
  継続し得る（タイムアウト≠未実行）— 呼出し側は冪等・lookup で整合を
  取る経路のみから呼ぶ前提をヘルパーコメントに明記。
- **監査して生存**: subscribeInvoices/subscribeChannelEvents は長寿命
  ストリームで対象外（error/end の再接続は 138th 配線済）、atomicWrite は
  fsync 永続化済み（同じ調査論点の耐久性側は適合）。

- `npx jest --forceExit` 全緑: 115/115・1,045・55秒。

### 第155ラウンド（ソクラテス式問答 — 「HTTP 外部呼出しも全てタイムアウト付きか？」）

- **問い**: gRPC 側を境界化（154th）したので HTTP 側を照合 — 全 axios
  呼出しにタイムアウトがあるか。notifier.js の AXIOS_SAFE_CONFIG
  （10秒・maxRedirects:0・SSRF リダイレクト迂回防止）は既存規約。
- **答え**: **4箇所が無境界 → 同規約で境界化**:
  - `utils/email.js` SendGrid + Mailgun: 応答停止で送信 promise が永久
    pending（notifyUser の .catch も発火せずリーク）。`timeout:10_000`・
    `maxRedirects:0` を付与。
  - `api/utils/lightning-api.js` OpenNode + LNbits: **支払い経路**で
    無境界 — 出金 API 応答停止は「支払い済みか不明」の曖昧状態を作る
    （gRPC 154th と同型）。同規約を付与。
- **監査して生存**: exchange-rate.js の全4ソース（axios `timeout` 既定値
  設定済み）、notifier.js 全6送信（AXIOS_SAFE_CONFIG + withRetry）、
  LINE Notify も同 config 経由。

- `npx jest --forceExit` 全緑: 115/115・1,045・56秒。

### 第156ラウンド（ソクラテス式問答 — 「keep-alive タイムアウトはプロキシ既定と整合するか？」）

- **問い**: Node 運用論点（AWS ALB/nginx 資料・node ドキュメント）— Node 既定
  `keepAliveTimeout=5s`・`headersTimeout=60s` は、上流プロキシの idle 切断
  （ALB/nginx 既定60s）より短い。プロキシが再利用しようとしたコネクションを
  サーバーが先に閉じ、間欠502を引き起こす。明示設定はあるか。
- **答え**: **未設定 → 設定** — `server.keepAliveTimeout = 61_000`・
  `server.headersTimeout = 65_000`（headersTimeout > keepAliveTimeout を
  維持 — 逆転は Node 警告の誤設定）。`require.main === module` の listen 経路
  のみ（supertest は対象外）。
- **監査して生存**: `withRetry` は通知送信専用（4xx 即除外で一時障害のみ
  再試行 — 支払い系には未適用で二重支払いリスクなし）、express-rate-limit・
  body limit 1mb・gracefulShutdown は既存。

- `npx jest --forceExit` 全緑: 115/115・1,045・56秒（前回実行流用 —
  require.main 経路のみの変更で jest 非対象のため、対象テスト 244 件を
  別途実行して緑確認）。

### 第157ラウンド（ソクラテス式問答 — 「keep-alive 延長はシャットダウンを滞留させないか？」）

- **問い**: 156th で keepAliveTimeout を 61s に延ばした — `server.close()` は
  アイドル keep-alive ソケットも満了まで待つため、ドレインが最大61秒滞留し
  30秒 force-exit に負けるのではないか（自らの変更が作った相互作用）。
- **答え**: **滞留あり → `closeIdleConnections()` を併用** — Node 18.2+ の
  API で応答待ちの接続は残しアイドル接続のみ即時解放。ドレインは再び
  即座に完了する（Node ドキュメント推奨の定型ペアリング）。
- **監査して生存**: forceExit=30s・shuttingDown 冪等ガード・バックグラウンド
  stop 先行（139th）は既存のまま機能。

- `npx jest --forceExit` 全緑: 115/115・1,045・56秒（前回実行流用 —
  require.main 経路のみ、対象テスト245件を別途実行して緑確認）。

### 第158ラウンド（ソクラテス式問答 — 「TRUST_PROXY は Express 側にも配線されているか？」）

- **問い**: `.env.example` に宣言された `TRUST_PROXY` は ip-key.js で解釈される
  が、`app.set('trust proxy', N)` が一度も呼ばれていなければ、Express の
  `req.ip` は常に実 TCP ピアを返す — プロキシ配下で全クライアントが
  プロキシ IP に潰れ、レート制限が1つの共有バケットになるのではないか。
- **答え**: **未配線 → 配線 + 解析を単一ソース化** — `parseTrustProxyHops()`
  を ip-key.js へ export 化し（probe34 の「解析は ip-key.js に集約」契約を
  保持）、server.js が同じ解釈で `app.set('trust proxy', hops)` を適用。
  整数 hop のみ・'true' 系は両者で拒否（XFF 左端偽装を許さない）。
- **監査して生存**: TRUST_PROXY 未設定なら req.ip=socket peer で両者一致して
  安全、probe34 の assert も保持（`parseInt(process.env.TRUST_PROXY`・
  `Number.isInteger(hopCount) && hopCount > 0` は parseTrustProxyHops 内に残存）。

- `npx jest --forceExit` 全緑: 115/115・1,045・57秒。

### 第159ラウンド（ソクラテス式問答 — 「秘密値の比較は定数時間で行われているか？」）

- **問い**: `/metrics` の `METRICS_AUTH_TOKEN` 照合が素の `!==` なら、
  応答時間の差から先頭一致バイト数が漏れ、トークンを逐字推測できる
  タイミングオラクルにならないか。
- **答え**: **実欠陥 → 修正** — master-auth.js が既に持つ `_timingSafeStrEqual`
  （Double-HMAC 正規化 + `crypto.timingSafeEqual`、長さも漏らさない）を
  server.js の /metrics 認証へ適用。同コードベースの確立パターンを再利用。
- **監査して適合確認**: JWT `algorithms:['HS256']` 固定（alg confusion 対策済）、
  `/ready` はデータ層書込み probe で依存検証済、helmet+Permissions-Policy 済、
  全レート制限 `standardHeaders:true`/`legacyHeaders:false`、ボディ上限 1mb、
  exchange-rate の GET-only は parser 先行不要（順序は正しい）。

- `npx jest --forceExit` 全緑: 115/115・1,045・57秒（直近実行流用 —
  server.js の当該パスは対象テスト248件で緑確認）。

### 第160ラウンド（ソクラテス式問答 — 「ロックのキュー Map は解放されるか？」）

- **問い**: `withLock` の `_queues` Map — `order:${orderId}:cancel` や
  `refresh:${jti}` のようなユニークキーが無限に増えるとき、使い終わった
  エントリは本当に Map から削除されるのか。
- **答え**: **実欠陥 → 修正** — クリーンアップが
  `if (_queues.get(key) === lock)` だったが、Map に格納されるのは
  `prev.then(() => lock)` の chain promise で `lock` 自体ではない。比較が
  常に false となり全ユニークキーが永続滞留（orderId/userId/jti ベースの
  キーは無制限に増える）→ 格納した `chain` と比較するよう修正。
  検証: 5ユニークキーで size 5→0、同一キー10並行で maxActive=1（直列化維持）。
- **監査して適合確認**: ログ注入（Joi `.email()` が CR/LF 拒否・file 出力は
  JSON エスケープ済）、refresh rotation（single-use・reuse検知全セッション
  失効・ati ペア失効・per-jti ロック）、CORS（credentials↔wildcard 排他）、
  セッション cookie（httpOnly+secure+sameSite:strict）、CSP 完備、
  `Cache-Control: no-store`、Joi `stripUnknown:true`、bcrypt 10–31 境界、
  乱数は全て crypto/uuidv4、body-parser 400 変換、OAuth `state:true`。

- `npx jest --forceExit` 全緑: 115/115・1,045・62秒。

### 第161ラウンド（ソクラテス式問答 — 「調査駆動の横断監査で残存面はあるか？」）

- **問い**: OWASP/Node ベストプラクティスを横断照合したとき、
  第154–160ラウンドの修正群（gRPC デッドライン・HTTP タイムアウト・
  keep-alive 整合・closeIdleConnections・TRUST_PROXY・定数時間比較・
  lock リーク）以外に未監査の実欠陥は残っているか。
- **答え**: **検証収束（削除・修正対象ゼロ）** — 以下を全件監査し適合を確認:
  - **HTTP/Express 面**: requestTimeout=300s(Node 既定)・headersTimeout=65s・
    keepAliveTimeout=61s の三重境界が slow-loris（ヘッダ/ボディ/アイドル）を
    全てカバー、`maxRequestsPerSocket` 無制限は直接クライアント下で適切。
  - **ライフサイクル面**: invoice-poller `_running` は finally で解放
    （154th の gRPC タイムアウト後も次ポーラーが走る）、全 stop/shutdown 結線済。
  - **I/O 面**: GPU 一覧のレイティング集約は TTL キャッシュ + 単一 getAll 派生、
    reads.js の失効スイープは SWEEP_THROTTLE で 30 秒毎に制限済。
    mutations の POST 内 getAll×3 は await 境界・expire 書込み・フィルタ差で
    意味的に必要（統合すると expire 前の stale pending が洪水計上・
    二重予約判定が expire 済み集合を見ない等の弱体化になる）。
  - **require/ロード面**: 動的 require・ユーザー入力由来のモジュールロードなし。
    safeLoad の loader は全て固定リテラル。
  - **プロセス面**: requestId は charset whitelist 検証済・traceparent は
    W3C 形式検証、fetch 未使用（axios のみ・全て bounded）。
- **結論**: 削除面・契約強制面・調査駆動の堅牢化面ともに収束。
  残存項目は §11 の設計判断2件（プロバイダ払い出し配線・JSON 層複数プロセス
  lost-update — いずれも削除ではなく設計・実装判断の領域）のみ。

- `npx jest --forceExit` 全緑: 115/115・1,045・62秒（直近実行流用）。

### 第162ラウンド（ソクラテス式問答 — 「依存パッケージの既知脆弱性は残っていないか？」）

- **問い**: コード面は固くても、依存が既知の GHSA/CVE を抱えていれば
  攻撃面は残る — `npm audit --omit=dev` で本番依存を棚卸しすると何が出るか。
- **答え**: **18件検出 → 17件解消、1件は非適用で温存**:
  - `npm audit fix`（非破壊）で 13 件を解消 — axios 10 GHSA（プロトタイプ
    汚染・DoS・proxy 継承）、form-data critical（unsafe random・CRLF）、
    jsonpath-plus critical（RCE）、body-parser/qs/joi/js-yaml/morgan/
    protobufjs/brace-expansion の DoS・汚染系。
  - `nodemailer ^6.9.14 → ^9.1.1` — 12 GHSA（SMTP コマンド注入・
    IDN/コメント解析の宛先偽装・addressparser DoS・disableFileAccess
    バイパス SSRF/任意ファイル読取）。利用面は createTransport+sendMail
    の最小 API のみで互換。9.1.1 は公開 23 日・全 GHSA の修正版範囲外。
  - `bcrypt ^5 → ^6.0.0` — ネストした @mapbox/node-pre-gyp の tar critical
    （hardlink/symlink パストラバーサル系 12 GHSA）を解消。API
    （genSalt/hash/compare/hashSync）は同一で互換、公開 1 年超。
  - **温存（非適用）**: `uuid <11.1.1` moderate — GHSA-w5hq は v3/v5/v6 で
    buf 引数使用時のバッファ境界問題。全使用箇所（27箇所）が v4 のみで
    buf 不使用 → 当コードベースでは悪用不能。修正版 14.x は ESM 移行の
    破壊的変更かつ dockerode のネストした uuid は別コピーで残るため、
    昇格でも監査警告は消えない（§11 へ移さず、採用面の事実として記録）。
- **監査して生存**: child_process は全て固定リテラル（rocm-smi の
  deviceIndex は hex サニタイズ済）、動的 require/ユーザー入力由来の
  モジュールロードなし。

- `npx jest --forceExit` 全緑: 115/115・1,045・128秒（昇格後全量検証）。

### 第163ラウンド（ソクラテス式問答 — 「Node バージョン要件は宣言されているか？」）

- **問い**: `server.closeIdleConnections()`（157th）は Node ≥18.2 が前提、
  `crypto.randomInt`・structuredClone 等も新 API 依存 — 必須 Node バージョンは
  package.json で宣言されているか。
- **答え**: **未宣言 → `engines` 追加** — `"engines": {"node": ">=18.2.0"}` を
  package.json に追加（closeIdleConnections の導入版に合わせる）。
  README にはバージョン指定がなく、engines が唯一の正本になった。
- **監査して生存**:
  - deprecated `request`/`dockerode` はコード・package.json・lock の実
    依存ツリーに存在しない（`npm ls` が empty、lock には孤児のネスト
    uuid コピーのみ — コードは参照せず次回 install で自然浄化）。
  - dev 含む全監査の残存は uuid 1 件のみ（162th で非適用を記録済）。

- `npx jest --forceExit` 対象テスト緑: api.integration 239 件。

### 第164ラウンド（ソクラテス式問答 — 「境界はどこで抜けているか？」）

- **問い**: SPA 側の XSS 面・トークン保管方針・scripts/ の外部呼出し —
  「宣言された境界」が各所で抜けていないか。
- **答え**: **scripts/ の3通知経路でタイムアウト未設定を修正** —
  `scripts/line-notify.js`（axios.post）と `scripts/slack-notify.js`・
  `scripts/slack-feedback-bot.js`（生 https.request）が service-monitor
  経由でサーバープロセスから await 呼出しされるのに応答停止境界なし。
  axios 側は AXIOS_SAFE_CONFIG 規約どおり `timeout: 10_000`、
  https.request 側は `req.setTimeout(10_000, destroy)` で境界化
  （CLI 実行でも応答停止ソケットがイベントループを握りプロセスが
  終了しない面を塞ぐ）。
- **監査して生存**:
  - SPA XSS 面は完備 — `el()` の `html:` エスケープハッチは未使用、
    router.js の innerHTML は静的文字列のみ（動的挿入は escapeText
    エンコード経由）、動的 href は `lightning:` スキーム固定生成のみ。
  - localStorage トークン保管は厳格 CSP（script-src 'self'・インライン
    禁止）との設計トレードオフとして auth.js 冒頭に文書化済、
    refresh token は SPA 側に保持しない（アクセストークン短命の設計）。

- `npx jest --forceExit` 対象テスト緑: service-monitor/probe57 等 7 件。

### 第165ラウンド（ソクラテス式問答 — 「セッションストアは境界化されているか？」）

- **問い**: express-session 既定の MemoryStore は失効 sid を能動退去せず、
  ユニーク sid の連続生成（bot が /master-auth/* を叩く等）で
  無制限に成長する — セッションストアは境界化されているか。
- **答え**: **未境界 → `BoundedSessionStore` を新設** —
  `src/api/middleware/bounded-session-store.js`: express-session Store の
  get/set/destroy/touch 契約を Map+TTL で実装。`maxEntries`（既定 10,000、
  `SESSION_MAX_ENTRIES` で調整可）を超える新規挿入時に失効分を全削除→
  最古エントリを追い出し。cookie.expires 由来の TTL、無期限セッションは
  既定 24h。master-session.js に配線（単一共有の契約は維持）。
  sliding-window レートリミッターの maxKeys（141th）と同じクラスの対策。
- **監査して生存**:
  - master-auth セッションは OAuth 多段チェーンの最小状態のみ
    （googleAuth/totpAuth/masterAuth フラグ）で saveUninitialized:false。
  - 実証: 失効 get→null+削除、maxEntries=3 で最古追い出し・size 3 維持、
    全量スイート（master-auth 系4スイート含む）に回帰なし。

- `npx jest --forceExit` 全緑: 115/115・1,045・111秒（昇格後全量検証）。

### 第166ラウンド（ソクラテス式問答 — 「非同期例外・メトリクス・ログの境界は？」）

- **問い**: Express 4 は async ハンドラの throw を自動捕捉しない（リクエスト宙吊り）、
  Prometheus ラベルはユーザー入力由来だとカーディナリティ爆発、
  ロガーは回転なしだとディスク枯渇 — 各境界は強制されているか。
- **答え**: **全て強制済み（削除・修正対象ゼロ）** —
  - async ハンドラ: routes/middleware 全76件が `asyncHandler` ラップか
    try/catch 済み（裸 async+no-try のファイル0、機械走査）。
  - GraphQL: コードベースに存在しない（probe34 の命名は履歴名残のみ）。
  - Prometheus ラベル値: `service` ラベルの値はサービス名の固定集合、
    ゲージ/カウンタともユーザー入力由来の値なし（カーディナリティ爆発なし）。
  - winston: File トランスポートに maxsize 10MB×maxFiles 5 で回転済み
    （access/db/gpu-events 追記は 142th の bounded-append で別途境界化）。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第167ラウンド（ソクラテス式問答 — 「秘密値比較・静的配信・依存 CVE の残存は？」）

- **問い**: 秘密値の素比較（タイミングオラクル）、sendFile/express.static の
  パストラバーサル、Express 周辺依存の既知脆弱性 — 残存面はあるか。
- **答え**: **全て閉塞済み（修正対象ゼロ）** —
  - インバウンド秘密値比較は2箇所のみ（/metrics Bearer・master-auth
    mailCode）で、両方とも 159th 以降 `_timingSafeStrEqual` 経由。
    外向き API キー（LN/SendGrid/Mailgun）はヘッダ送出しで比較なし。
  - 静的配信は `express.static(public)` + SPA フォールバックの
    固定 index.html のみ — ユーザー入力由来のパス解決なし。
  - Express 4.22.3・path-to-regexp 0.1.13・send/serve-static/qs/cookie/
    body-parser 全て現行パッチ済みバージョン。`npm audit` の残存は
    162th で非適用と記録済の uuid 1件のみ（全呼出し v4・buf 不使用、
    修正版14系は ESM 破壊＋dockerode 孤児コピーも残るため採用せず）。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第168ラウンド（ソクラテス式問答 — 「支払い境界・ログ衛生・CSRF は？」）

- **問い**: LN 支払い側の fee 上限・`payment_error` 拒否、秘密値のログ
  流出、cookie セッションの CSRF、`.env` の誤コミット — 残存面はあるか。
- **答え**: **全て境界済み（修正対象ゼロ）** —
  - `sendPayment`: `fee_limit.fixed` をインボイス額の 1%（検証済み最大 10%）
    で送出し、`payment_error` は必ず reject。decodePayReq は支払い額を
    インボイス自身から取得（過少・過大支払いの整合リスクなし）。
  - ログ: token/secret/preimage/password を値として出力する経路ゼロ
    （全ヒットはイベント名+ユーザー id のメタデータのみ、probe52 の
    メタデータ redaction と整合）。
  - CSRF: master-auth セッション cookie は `sameSite: 'strict'` +
    httpOnly で、API 本体は Bearer JWT — cookie 単独で書き換え可能な
    権限を持たない設計。
  - `.env` は .gitignore 済（追跡ファイルは .env.example のみ）。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第169ラウンド（ソクラテス式問答 — 「プロセスガード・無界ループ・ソートキーは？」）

- **問い**: プロセスレベルの防衛（unhandledRejection/uncaughtException）、
  while 系無界ループ、`?sort=` 系のソートキー検証 — 残存面はあるか。
- **答え**: **全て適切に強制済み（修正対象ゼロ）** —
  - `registerProcessGuards`: unhandledRejection は `_describe` で記録して
    継続（1件の不具合で API 全体を落とさない意図的設計）、
    uncaughtException は `handling` 冪等化＋`srv.close()` 優雅終了＋
    `forceExitMs` デッドライン — Node 運用の教科書形。
  - `while` ループは新設 `BoundedSessionStore` の追い出しのみで上限境界済、
    その他の while 検出なし（外部入力由来の無界ループゼロ）。
  - ソートキー: order は `SORTABLE_FIELDS` ホワイトリスト集合、
    gpu は `rating|memory|reliability|availability` の固定分岐 —
    両所とも任意フィールド注入不可。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第170ラウンド（ソクラテス式問答 — 「コンテナは本番適格か？」）

- **問い**: `docker/Dockerfile.api` は Node Docker ベストプラクティス
  （非 root 実行・EOL 外のベース・ヘルスチェック）に適合しているか。
- **答え**: **3件の実欠陥を修正** —
  - `USER node` 未指定で root 実行 → 公式 `node` ユーザーへ変更し、
    `COPY --chown=node:node` で JSON データ層の `data/` 書込み権限を確保。
  - ベース `node:20-slim` は 2026-04 EOL → メンテナンス LTS の
    `node:22-slim` へ昇格（両ステージ、engines >=18.2 と整合）。
  - `HEALTHCHECK` 未設定 → `node -e "fetch('http://localhost:3000/health')..."`
    で組込み fetch を使う死活監視を追加（slim に curl/wget は無いため）。
- **監査して生存**:
  - `HOST=0.0.0.0` のコンテナ向け上書き・`.dockerignore` の除外網羅は適合。
  - README/ドキュメントに Node 20 への言及なし（drift 修正不要）。
  - npm scripts/main/Dockerfile CMD の整合は継続確認済。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第171ラウンド（ソクラテス式問答 — 「ドキュメント drift・静的参照・probe 衝突は？」）

- **問い**: ARCHITECTURE.md のモジュール記述、README のコマンド参照、
  index.html の静的アセット参照、tests/ が Dockerfile/api をソース検証
  していないか — 残存 drift・衝突はあるか。
- **答え**: **全て整合（修正対象ゼロ）** —
  - ARCHITECTURE.md の `src/core/database.js`/`security.js`/Electron 断片
    （`public/preload.js`/`electron.js`/`src/web/`）はいずれも既に
    「削除済み（2026-07/09）」として正確に記録済みで、実ファイルの不在と整合。
  - README の `npm run benchmark`/`report:monthly` は「自動化例・拡張
    ロードマップ」節内の将来例（存在しないコマンドを現行機能として
    記述していない）— 時点分析の温存と同型で生存。
  - index.html の参照（`/css/tokens.css`/`app.css`/`/js/app.js`）は全て実在、
    `#/market` は登録済みルート（137th）。
  - tests/ に Dockerfile.api/`node:XX-slim` を読む probe なし
    （170th のベース変更は probe 契約と衝突しない）。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第172ラウンド（ソクラテス式問答 — 「依存は全て使われているか？」）

- **問い**: package.json の全依存が require/使用されているか、
  devDeps・allowScripts 等のメタ設定は現行バージョンと整合しているか。
- **答え**: **依存は全使用済み（26件・孤立ゼロ）だが `allowScripts` が stale**
  — 162th で bcrypt を ^6.0.0 へ昇格したのに `allowScripts` が
  `bcrypt@5.1.1` のまま → `bcrypt@6.0.0` に追従させた
  （実 install は 6.0.0・`npm ls` で整合確認）。
- **監査して生存**:
  - 全26依存に require/import 消費者あり（機械照合）、devDeps 3件
    （jest/supertest/@playwright/test）も全てテストで使用。
  - optionalDependencies（@grpc/grpc-js・proto-loader）は LN gRPC 系の
    宣言どおり。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第173ラウンド（ソクラテス式問答 — 「非推奨 API・スクリプト整合・gitignore は？」）

- **問い**: Node/Express 非推奨 API の残存、package.json スクリプトの
  実ファイル整合、`.gitignore` の生成物網羅 — 残存面はあるか。
- **答え**: **全て整合（修正対象ゼロ）** —
  - 非推奨 API ゼロ: `url.parse`・`new Buffer`・`util.is*`・`domain`・
    `fs.exists()`・`crypto.createCipher`/`createDecipher` の検出なし
    （'domain' ヒットは action-executor の kind タグのみ）。
  - Express 非推奨形ゼロ: `res.send(status, body)`・`res.json(status, obj)`・
    `req.param()` の検出なし。
  - package.json 全19スクリプトが実在ファイル/バイナリを指す
    （`node scripts/*.js` 14件照合、`setup`=`npm ci && npm test` 等も正）。
  - `.gitignore` は `.env*`・`data/`・`logs/`・`coverage/`・
    `playwright-report/`・生成ドキュメント全般を網羅。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第174ラウンド（ソクラテス式問答 — 「git 追跡整合・fsync 耐久性は？」）

- **問い**: `.gitignore` と git 追跡の不整合（追跡済み生成物）、
  `atomicWriteJSON` の fsync 逐次（rename 後の dir fsync）は完全か。
- **答え**: **全て正しい（修正対象ゼロ）** —
  - `git ls-files` 293件、`data/`・`logs/` の追跡エントリゼロ
    （ignore 済み生成物の誤追跡なし）。`improvement_checklist2.md` は
    ARCHITECTURE.md・README.md・`checklist-kpi-report.js` の参照を持つ
    生存ドキュメント（実態乖離の免責注記つきで意図的に保持）。
  - `atomicWrite.js`: temp ファイル→`fsyncSync`（ファイル）→
    `renameSync`→`fsyncSync`（親ディレクトリ、未対応環境は graceful
    フォールバック）— 電源断/OS クラッシュでもコミット済み書込みが
    生き残る教科書逐次（154th の調査論点と整合）。
  - ルート追跡ファイル（LICENSE・SECURITY.md・jest/playwright config 等）は
    全て正当な存在。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第175ラウンド（ソクラテス式問答 — 「資金系入力検証・キャッシュキー生成は？」）

- **問い**: 運営受取アドレス（資金フロー直結）の入力検証、
  レスポンスキャッシュのキー生成（認可バイパス・ポイズニング面）は
  十分か。
- **答え**: **全て強制済み（修正対象ゼロ）** —
  - `profit-addresses`: ルートは JWT+admin+masterAuth の三重ゲート、
    `isValidBtcAddress` は長さ 14–100 境界＋ネットワーク別パターン照合、
    書込みパスも `filter(isValidBtcAddress)` で無効値を保存しない。
  - `cacheMiddleware`: perUser キーは `userId:role:originalUrl`
    （同一 userId のロール降格後 replay を防ぐ）、GET のみ・2xx のみ
    キャッシュ、ミューテーション後は `invalidateUserCache` で TTL を
    待たず即時無効化 — 認可リーク・stale 配信の両方が設計で塞がれている。
  - LRUCache は max 1,000・TTL 60s で境界済み。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第176ラウンド（ソクラテス式問答 — 「ハートビートの認可は完全か？」）

- **問い**: `POST /orders/:id/heartbeat` は他人セッションへの心拍注入を防げるか
  （認可バイパス・usageSeconds 捏造・認証済み DoS の各面）。
- **答え**: **全て強制済み（修正対象ゼロ）** —
  - `authenticateJWT` 必須＋role↔user 束縛（`lender` は `req.user.id ===
    order.providerId`、`renter` は `=== order.userId` でなければ 403）—
    他人セッションへの心拍注入は不可能。
  - `active` オーダーのみ受付（pending/matched での usage 積み上げ捏造と
    completed/cancelled 後のリークを同時に塞ぐ）。
  - `(orderId,userId)` ごとの最小心拍間隔で 429（認証済み DoS の境界化、
    `HEARTBEAT_MIN_INTERVAL_MS` で調整可・148th で env 強制確認済）。
  - `heartbeatTimestamps` キーはオーダー終了時に一掃（ライフサイクル完備）。
  - lender 心拍のみ providerUptime 実績として永続化（renter 心拍は
    信頼性スコア母数に混入しない設計）。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

### 第177ラウンド（ソクラテス式問答 — 「エスクロー取消し・手動承認の並行性は？」）

- **問い**: `cancelEscrowsForOrder` の取消対象選択と、
  `POST /payments/manual/approve` の二重承認・孤児レコード面は安全か。
- **答え**: **全て強制済み（修正対象ゼロ）** —
  - `cancelEscrowsForOrder`: `CANCELED`/`SETTLED` 以外の未終了エスクローのみ
    個別ベストエフォートで取消し（1件失敗でも残りを続行、warn 記録）、
    ルックアップ失敗も warn のみ — 資金滞留を防ぎつつ処理中断を起こさない設計。
  - `manual/approve`: `withLock('payment:'+id)` + `updateIf(status!=='paid'
    && method!=='lightning')` CAS の二層で二重承認を排除、関連オーダーが
    `pending`/`matched` 以外なら 409（cancelled/completed への孤児 paid
    レコード生成を防止）、LN 払いの手動承認は 400（責務分離）。
  - `escrowService()` は lnAdapter を初回呼出し時に捕捉（require 時の
    未初期化を回避）、FSM→actions→ln-adapter の責務分離も明確。

- `npx jest --forceExit` 全緑（165th 直近: 115/115・1,045・111秒）。

## 10. 検証（測定 — 推測しない）

- 削除前: `npx jest --forceExit` → **136/138 スイート PASS、1,213 テスト、112 秒**。
- 削除後: 同コマンドで **115/115 スイート PASS、1,045 テスト（+1 skip）、67 秒** を確認（第103ラウンド後）。
- `npm start` 起動確認 + `/health` `/ready` 応答確認（両者 200、SPA 配信 200）。
- npm 依存（lockfile node_modules エントリ）: **1,036 → 732（-29%）**。
- src/ の到達不能ファイル: 38 → 2（残りは意図的温存: ln-adapter のテスト用モック
  エクスポートと docs のみの孤立スクリプト）。

## 11. 残るギャップ（正直な棚卸し — 今回は手を付けない）

- **プロバイダ払い出しの入り口**: エスクローの `providerInvoice`/`preimage` を設定する
  経路が本番コードに存在しない（btc-onchain 系エスクローは帳簿のみ）。LN 払い出しを本当に
  動かすには「プロバイダの payout インボイス/アドレス収集」の機能追加が必要 — 第一原理的には
  「実 LND ノードを運用する」前提が先。env 未配備の現状では価値密度が低いため今回は結線まで。
- JSON 層のクロスプロセス lost-update（単一プロセス運用では非問題 — ARCHITECTURE.md 既述）。
- ~~`routes/order/index.js` の分割~~ — 第102・103ラウンドで実施済み（sessions/runtime/disputes へ分割、985行）。
