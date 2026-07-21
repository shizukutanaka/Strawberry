# Strawberry エージェントハンドブック（Opus / Sonnet 向け指示書）

> **対象読者**: このリポジトリで作業する AI エージェント（Claude Opus / Sonnet 等）および人間の開発者。
> **目的**: 前提知識ゼロのセッションが、現状を正しく理解し、安全に改善作業を引き継げるようにする。
> **鮮度**: 2026-07 時点。記載の数値（テスト件数・カバレッジ等）はすべて実測値。作業開始時に必ず再計測して最新化すること。

---

## 1. プロダクト概要（30秒版）

Strawberry は **P2P GPU レンタルマーケットプレイス**。プロバイダーが GPU を出品し、借り手が Bitcoin Lightning（sats建て）または銀行振込（管理者手動承認）で支払って時間貸しする。Node.js/Express + JSON ファイル永続化 + ビルド不要のバニラJS SPA（`public/`）。日本語UIファースト。

- 起動: `npm start`（`src/api/server.js`、既定 PORT 3000、`/health` でヘルスチェック）
- テスト: `npm test`（jest）/ `npm run test:e2e`（Playwright）
- 主要ドキュメント: `ARCHITECTURE.md`（構成と既知の制約）、`docs/SPECIFICATION.md`（仕様）

---

## 2. 長所（検証済みの強み — 壊さないこと）

以下はすべて実測・テストで確認済みの資産。**変更時はこれらを退行させない**。

### 2.1 動くフロントエンド一式
- `public/` 配下の no-build SPA（ネイティブESモジュール、ハッシュルーティング `#/market` 等、`public/js/router.js` の cleanup 契約でポーリングリーク防止）。
- **厳格CSP準拠**（`script-src 'self'`、インラインスクリプト・CDN一切なし）。`onclick=` 属性は使用禁止、全て `addEventListener`。
- WCAG 2.2 対応済み: コントラスト比は実測4.5:1以上（`public/css/tokens.css` の success/warning/danger は計算検証済み）、sticky ヘッダーのフォーカス遮蔽対策（`scroll-padding-top`）。
- 画面: 登録/ログイン、マーケット（フィルタ・ソート・信頼性/検証バッジ・相場統計）、GPU登録/管理/詳細、注文ライフサイクル状態機械、係争申請・管理者裁定、管理者決済承認、プロバイダー収益、価格ウォッチ。

### 2.2 テスト資産
- **jest: 133+ スイート / 1232 テスト green**（統合テスト中心。supertest で実 Express アプリを駆動）。
- **Playwright E2E: 25 テスト / 7 スペック**（`tests/e2e/`。実サーバー＋実ブラウザで全主要フロー走破、コンソールエラーゼロをアサート＝CSP違反検知ゲート）。
- **行カバレッジ 70.98%**（CI ゲートは 70%。余裕は約1%しかない — §5.4 参照）。

### 2.3 データ層の整合性
- 全リポジトリ（`src/db/json/*`）は `createJsonRepository` ファクトリ経由: 原子的書き込み（temp+rename+fsync、`atomicWrite.js`）、破損時 fail-closed（黙って `[]` を返さず throw）、`updateIf` による CAS、プロトタイプ汚染キー除去。
- 注文の状態遷移は per-order mutex（`withLock('order:${id}')`）＋ CAS の二段構え。決済承認も同パターン（`withLock('payment:${id}')`）。

### 2.4 セキュリティ実装
- JWT: HS256 固定（alg混同攻撃対策）、リフレッシュトークンのアクセス利用拒否、jti失効（logout）、パスワード変更/無効化後の全セッション失効。`tests/api/middleware/security-middleware.test.js` が全分岐を固定。
- BOLA対策: オブジェクトルートは所有権チェック済み（`allowOwnerOrAdmin` 等）。公開レスポンスから `providerId`/`apiKey`/`manualBlocks` を投影除外（プロバイダー列挙・renterプロファイリング防止）。
- SSRF: Webhook送信は `assertPublicUrl`（名前解決込み）＋ `maxRedirects:0` ＋ サイズ/タイムアウト上限。
- レート制限（`NODE_ENV=test` でバイパス）、ハートビートDoS対策（最小間隔10s）。

### 2.5 マーケットプレイスの信頼機能（2026年業界調査ベース）
- **プロバイダー信頼性スコア**: ハートビート履歴を `data/uptime.json` に永続化し 0–1 スコア化（`src/reputation/provider-uptime.js`）。一覧・詳細・ソート（`?sort=reliability`）に反映。Vast.ai 型の「レビュー（主観）＋稼働実績（客観）」2シグナル設計。
- **SLA 自動処理**: プロバイダーのハートビートが猶予（既定5分、`SLA_PROVIDER_HEARTBEAT_TIMEOUT_MS`）を超えて途絶した active 注文を自動終了し、実提供分のみ按分課金・残額返金対象化・信頼性減点（`sweepHeartbeatSlaBreaches`, `src/api/routes/order/index.js`）。
- **検証ティアの正直表示**: attestation は「自己申告 / 実測検証済み / 検証失敗」をUIで明示。nvidia-smi 出力は vBIOS 改竄で欺瞞可能という前提の設計。
- **相場統計**: `GET /gpus/:id/market-rate`（同機種の中央値/最小/最大 sats/時）。
- **自動失効ジョブ**: pending決済タイムアウト/matched未開始/disputed放置（7日で自動裁定）/active超過（`src/utils/order-expiry.js`）。

### 2.6 可観測性
- opt-in OpenTelemetry（`src/telemetry/instrumentation.js`）。`OTEL_EXPORTER_OTLP_ENDPOINT` 未設定時は require すらしない完全 no-op。server.js の先頭 require 必須（順序を変えないこと）。

---

## 3. 短所（既知の制約 — 深刻度つき）

### 重大（プロダクトの本質に関わる）
1. **資金移動が未完**。エスクロー状態機械（`src/payments/escrow-state-machine.js`）・LNアクション実行（`action-executor.js`）・LNアダプタは実装・テスト済みだが、**現行の決済フロー本体（`src/api/routes/payment/index.js`）はエスクローを作らない**。インボイス直接支払い＋手動承認のみで、プロバイダーへの実送金は記録上のみ。→ 改善案 P1-1。
2. **実ワークロード配信なし**。`/start` は課金・状態遷移のみ正しく行い、`accessInfo.deliveryImplemented:false` を正直に返す（偽エンドポイントは廃止済み）。借り手は実際にはGPUに接続できない。→ 改善案 P2-3。

### 中程度
3. **JSONファイル永続化のスケール限界**: 全読込 O(n)、単一プロセス前提。これが jest `maxWorkers:1` の理由でもある。→ P3-1。
4. **トークンが localStorage**（`public/js/auth.js`）。厳格CSPがXSS面を大幅緩和しているが、httpOnly Cookie が本筋。→ P2-1。
5. **パスワードのみ認証**。2026年基準では金銭を扱うサービスとして見劣り（トップ100サイトの48%がパスキー提供）。→ P2-2。

### 軽微・環境起因
6. nvidia-smi ベース attestation の改竄可能性（設計上明示済み。ベンチマーク型検証は実GPU環境が必要）。
7. `.github/workflows/` は Claude Code 実行環境の GitHub App 権限（workflows スコープ欠如）で**変更不可**。ワークフロー自体の修正はリポジトリオーナーの手作業。
8. npm audit に既存39脆弱性（13 moderate/15 high/11 critical）。多くは deprecated 依存（apollo-server v3, aws-sdk v2, request 等）由来。→ P3-2。

---

## 4. 改善案（優先度つき・独立作業単位）

各項目は「目的 / 対象 / 受け入れ条件 / 検証」で完結し、単独のセッションで実装可能。**着手前に必ず §5 の作業規約を読むこと。**

### P1-1: hold invoice エスクローを決済フローに接続（最重要）
- **目的**: 短所#1の解消。RoboSats 方式（Lightning マーケット唯一の本番エスクロー実例）: 借り手の支払いを hold invoice でロック（未確定）→ 注文完了時に settle ＋ プロバイダーの BOLT11 へ送金 → キャンセル/返金時は invoice を cancel（**返金送金そのものが不要になる**）。
- **対象**: `lightning-service.js`（mock LND に `addHoldInvoice`/`settleInvoice`/`cancelInvoice` を追加）、`src/api/routes/payment/index.js`（lightning 決済時にエスクローレコード作成）、`src/api/routes/order/index.js` の `/stop`・係争裁定（既存の `escrowSvc.apply()`/`cancel()` 呼び出しに `lnAdapter` DI を渡す — `createEscrowService({ lnAdapter })` の配線は実装済み）。
- **制約を設計に反映**: hold は実務上数時間が上限（経路上のHTLC占有）。長時間レンタルは「承認→開始ウィンドウのみ hold、以降は時間ブロック前払い（P1-2）」とする。
- **受け入れ条件**: mock LND に対し「承認→hold→完了→settle→プロバイダー支払い記録」「係争refund→cancel→ロック解除」の両パスが契約テストで green。既存 1232 テストに退行なし。
- **検証**: 新規 jest 契約テスト + `tests/api/lightning-payment-e2e-smoke.test.js` の拡張。

### P1-2: 時間ブロック前払い課金
- **目的**: 決済信頼性論文の一致した結果（金額が大きいほどLN決済成功率低下）と hold 時間上限への対応。1時間毎等の小口 BOLT11 を順次請求し、未払いで自動サスペンド。
- **対象**: `src/api/routes/payment/index.js`・`order/index.js`・`public/js/pages/order-detail.js`。
- **受け入れ条件**: ブロック未払い時に SLA スイープが注文をサスペンドし按分精算すること。

### P2-1: httpOnly Cookie セッション
- **対象**: `src/api/middleware/jwt-auth.js`・`security.js`・`public/js/auth.js`・`api.js`。CSRF 対策（SameSite=Lax + カスタムヘッダ検証）同伴必須。localStorage 経路と並行稼働させ、段階移行。

### P2-2: パスキー（WebAuthn）追加
- **対象**: `@simplewebauthn/server` を devDependencies でなく dependencies に追加、`src/api/routes/user/` に register/authenticate エンドポイント、`public/js/pages/login.js`・`register.js` にオプションUI。パスワードは残す（オプション追加であって置換ではない）。

### P2-3: Docker+SSH ワークロード配信の設計文書化（実装はしない）
- **対象**: `docs/` に設計文書のみ。プロバイダー側常駐エージェント（Docker pull→run→接続情報report）の API 契約を定義。**この実行環境では実GPU/実Dockerの検証ができないため、実装はローカル環境を持つ開発者に委ねる。**

### P2-4: interruptible/spot 二段価格
- **前提**: 信頼性スコア（実装済み）。プロバイダーが「中断可価格」を設定でき、フル価格注文が来たら按分返金で中断。NSDI'24 Best Paper（Can't Be Late）が学術的裏付け。

### P3（方向性のみ）
1. DB移行: Prisma+Postgres（`prisma/` に雛形あり）。jest 並列化が可能になる。
2. 依存刷新: apollo-server v3→`@apollo/server` v4、aws-sdk v2→v3、supertest v7。audit 39件の大半が解消見込み。
3. L402 ゲート付きマシンAPI（AIエージェント課金の潮流）。
4. 実LND・実GPUベンチマーク検証（実インフラ必須）。

### 非推奨（調査済み・やらない理由つき）
- **zkML 検証**: prover オーバーヘッドが依然過大（2025-26時点の文献確認済み）。
- **NVIDIA CC/NRAS 必須化**: H100/Blackwell + SEV-SNP/TDX ホスト限定でコンシューマGPU供給に無関係。ティアの受け口だけ確保済み。
- **トークン/ステーキング**: Akash のプロバイダー離脱・io.net の Sybil 事件（自己申告メタデータ信用で偽GPU 180万台）が反面教師。
- **逆オークション**: 遅延増・小規模参加者排除（arXiv:2511.16357）。固定価格＋spotティアが正解。
- **厳密再計算によるGPU計算検証**: 浮動小数点非決定性で原理的に不可能（arXiv:2501.05374）。

---

## 5. 作業規約（このリポジトリで安全に働くためのルール）

### 5.1 検証規律（最重要）
- **記憶や推測でなく、実行して確かめる。** 機能変更は必ず: 実装 → 対象スイート green → **フル jest green**（~6分）→ 必要なら E2E → コミット → push。
- コンテナ再起動をまたいだら、`git status`/`git log` で実状態を再確認してから続行（記憶上の状態を信用しない）。
- 「テストが落ちた」ときは、テストのバグかアプリのバグかを**サーバー側状態の独立確認**で切り分ける（楽観的UI表示を信用しない）。

### 5.2 テストの実行方法
```bash
NODE_ENV=test npx jest --forceExit          # フルスイート（serial, ~6分）
NODE_ENV=test npx jest tests/api/foo.test.js # 単一スイート
npm run test:e2e                             # Playwright（webServer自動起動、要Chromium）
```
- jest は **maxWorkers:1（直列）必須** — JSON データ層をワーカー間で共有するため並列だと非決定的に壊れる。`jest.config.js` から外さないこと。
- **forceExit 必須** — LNDモック・監視インターバル等の open handle で自然終了しない。`jest.config.js` に設定済み（CI の bare `npx jest` 呼び出しにも効く）。
- `tests/e2e/` は Playwright 専用で jest から除外済み（`testPathIgnorePatterns`）。jest で実行すると必ず throw する。
- `tests/globalSetup.js`（jest）と `tests/e2e/globalSetup.js`（Playwright）が毎回 `data/*.json` をリセットする。**新しい JSON データファイルを追加したら両方のリセット対象リストに追加すること**（追加漏れはクロステスト汚染として非決定的に発現する）。

### 5.3 環境の罠（実際に踏んだものだけを列挙）
| 罠 | 症状 | 対処 |
|---|---|---|
| クリーンチェックアウトに `data/` が無い | globalSetup が ENOENT で全スイート即死 | globalSetup が `mkdirSync(recursive)` 済み。消さないこと |
| CIランナーに `/var/run/docker.sock` が存在 | `detectPlatform()` が 'docker' 誤検出 → marketplace GPU の `/start` が 500 | marketplace GPU（`vgpu.type==='marketplace'`）は常に native アクセス経路（修正済み、`virtual-gpu-manager.js`）。**ローカルで通ってCIで落ちる時はまずこの種の環境差を疑う** |
| カバレッジCIゲート 70%（現在 70.98%） | コード追加だけするとゲート割れ | **プロダクションコードを足すときは必ずテスト同伴**。閾値チェックは `coverage-summary.json`（json-summary reporter、設定済み）依存 |
| レート制限 | テスト・手動検証で 429 | `NODE_ENV=test` で緩和される（`apiLimiter`） |
| ハートビート最小間隔 10s | 高速テストで 429 | `HEARTBEAT_MIN_INTERVAL_MS` で下げる（下限1000ms） |
| SLA/失効タイムアウト | テストで待てない | すべて env で上書き可（`SLA_PROVIDER_HEARTBEAT_TIMEOUT_MS`, `ORDER_*_TIMEOUT_*` — 下限クランプあり） |
| `.github/workflows/` への push | GitHub App に workflows 権限がなく **push自体が拒否される** | ワークフロー変更が必要な修正は、アプリ側（jest.config.js 等）で代替するか、オーナーへの手作業依頼として明記 |
| jest teardown 後のタイマー発火 | 「import after teardown」ノイズ | 遅延 require するインターバルコールバックは try/catch で包む（既存パターン踏襲） |

### 5.4 コード規約
- **正直なUI原則**: 未実装機能を実装済みに見せない。`deliveryImplemented:false` のような明示フラグ＋説明文を返す。偽の成功・偽のエンドポイントは重大バグとして扱う。
- コメントは日本語で「なぜ」を書く（何をしているかではなく）。既存ファイルのコメント密度・スタイルに合わせる。
- 状態遷移は必ず CAS（`updateIf`）か mutex（`withLock`）経由。素の `update` で status を書き換えない。
- 公開APIレスポンスに `providerId`・`apiKey`・`manualBlocks`・reviewerId を含めない（列挙・プロファイリング防止の投影ルール）。
- 新規の外部HTTP送信は `assertPublicUrl` ＋ タイムアウト/サイズ上限/`maxRedirects:0` を踏襲。
- フロントエンドはインラインスクリプト・インラインイベントハンドラ・CDN禁止（CSPで沈黙死する）。DOM構築は `el()` ヘルパー（innerHTML不使用）。

### 5.5 git 規約
- 作業ブランチ: `claude/deepresearch-ultrathink-improvement-NEMJb`（指定がある場合はそれに従う）。
- push 前に必ず: `git fetch origin <branch>` → `git merge-base --is-ancestor origin/<branch> HEAD` で divergence 確認。
- マージ済みPRのブランチに続きを積まない: `git checkout -B <branch> origin/main` で main から再作成してから新規作業。
- コミットメッセージ: 何を・なぜ・**どう検証したか**（テスト件数・実測値）を本文に書く。
- PR はユーザーの明示的な依頼があるときのみ作成。

---

## 6. 現状の未マージ作業（2026-07 時点のスナップショット）

`main` は PR #2（b21c92f）まで反映済み。ブランチ `claude/deepresearch-ultrathink-improvement-NEMJb` には以下が **main 未反映**で積まれている（これらを取り込むと、従来一度も緑になったことのない `test`（Test & Coverage）CIチェックが green になる）:

- marketplace GPU の docker platform 誤検出 500 修正（`f2744e3`）
- CI globalSetup の `data/` 作成（`6cde5a1`）
- jest 設定: forceExit + json-summary reporter（`092588e`）
- カバレッジ引き上げ 67.8%→70.98%: core/logger・utils/notifier・order-expiry ジョブ・認証ミドルウェア・決済承認ガードのテスト群（`d92b66c`〜`8d4a335`）

この節は作業が進んだら更新するか、古くなっていたら削除してよい（§1 の鮮度原則）。
