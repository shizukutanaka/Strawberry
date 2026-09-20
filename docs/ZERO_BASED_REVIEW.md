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

## 10. 検証（測定 — 推測しない）

- 削除前: `npx jest --forceExit` → **136/138 スイート PASS、1,213 テスト、112 秒**。
- 削除後: 同コマンドで **123/123 スイート PASS、1,140 テスト、44 秒** を確認。
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
- `routes/order/index.js` の分割（動作中・大改修の価値密度が現状低い）。
