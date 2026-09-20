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
