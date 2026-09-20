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
