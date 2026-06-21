# Strawberry 仕様書（Specification）

> P2P GPU マーケットプレイス — Node.js / Express バックエンド
> 最終更新: 2026-06-21 / 対象ブランチ: `claude/deepresearch-ultrathink-improvement-NEMJb`

本書は Strawberry の **実態に基づく** 仕様書である。README / `improvement_checklist2.md` の
「実装済み」表記には実態と乖離があるため、本書はソースコードを一次情報として記述する。
末尾に **長所・短所・改善点** を洗い出し、本サイクルで実装した改善を明記する。

---

## 1. システム概要

Strawberry は遊休 GPU を貸し借りする二面市場（two-sided marketplace）である。

- **プロバイダ（貸し手）**: GPU を登録し、稼働条件（価格・最低借り手評価・メンテ枠）を設定する。
- **借り手（renter）**: GPU を検索し、注文を作成し、Lightning / オンチェーン BTC で支払う。
- **運営**: 手数料を受け取り、紛争を裁定し、管理操作を行う。

決済は Lightning Network（LND）とオンチェーン BTC を想定。P2P レイヤ（libp2p）と
仮想 GPU 管理（Docker/K8s）はオプション扱いで、未導入でも API 本体は起動する。

### 1.1 技術スタック

| レイヤ | 採用技術 |
|--------|----------|
| HTTP | Express 4 |
| 認証 | JWT（HS256, アクセス+リフレッシュ, ローテーション付き）、Google/GitHub OAuth、マスター3重認証（OAuth+TOTP+メール） |
| データ層 | JSON ファイルリポジトリ（`src/db/json/*`、`atomicWrite` による `fs.rename` 原子書き込み） |
| セキュリティ | helmet（CSP）、cors、express-rate-limit、bcrypt、speakeasy（TOTP） |
| 監視 | prom-client（`/metrics`）、service-monitor、invoice-poller |
| API ドキュメント | joi-to-swagger |
| オプション | libp2p（P2P）、@grpc/grpc-js（LND）、dockerode / @kubernetes/client-node（仮想GPU） |

---

## 2. アーキテクチャ

```
                 ┌──────────────────────────────────────────┐
   HTTP ────────▶│ Express (src/api/server.js)              │
                 │  helmet → cors → rate-limit → JWT gate    │
                 └───────────────┬──────────────────────────┘
                                 │ src/api/routes/index.js (/api/v1)
        ┌────────────┬───────────┼───────────┬───────────┬───────────┐
      /gpus       /orders     /payments    /users    /marketplace  /auth
        │            │            │            │
        ▼            ▼            ▼            ▼
                 src/db/json/*Repository  (createJsonRepository)
                                 │
                                 ▼
                     data/*.json  (atomicWrite: fs.rename)

  オプション（未導入時は null フォールバック → 503）:
    core/services.js → LightningService / P2PNetwork / VirtualGPUManager
  バックグラウンド: service-monitor, invoice-poller
```

### 2.1 データ層の特性（重要）

`createJsonRepository` は **インメモリキャッシュを持たない**。`getById`/`getAll` は毎回
`fs.readFileSync` でディスクから読む。書き込みは `atomicWrite`（一時ファイル→`fs.rename`）。

- `updateIf(id, predicate, patch)`: 単一プロセス内で原子的な compare-and-swap。
- `withLock(key, fn)`: プロセスローカルなキー単位の非同期ミューテックス（`src/utils/async-lock.js`）。

> **制約**: 原子性・ロックは **単一プロセス内** のみ保証。水平スケール（複数 Node プロセス）
> では `withLock` も `updateIf` も競合を防げない。マルチプロセス運用には外部の
> トランザクショナルストア（PostgreSQL 等）への移行が前提となる（→ 改善点 D-1）。

---

## 3. データモデル（主要エンティティ）

| エンティティ | 主フィールド | 備考 |
|--------------|-------------|------|
| User | id, email, username, password(bcrypt), role, peerId, passwordChangedAt, sessionsRevokedAt, twoFactorSecret | センシティブ項目は `sanitizeUser()` で除去 |
| GPU | id, providerId, name, vendor, model, memoryGB, pricePerHour, minRenterRating, **rejectUnratedRenters**, manualBlocks[] | providerId/manualBlocks は非オーナーに非開示 |
| Order | id, gpuId, userId, status, matchedAt, startedAt, stoppedAt, completedAt, dispute, review, renterReview | status: pending→matched→active→completed/cancelled |
| Payment | id, orderId, userId, method(lightning/onchain/manual), status, paidAt | userId は **order.userId**（作成者ではない） |
| Escrow / Reputation / Verification | — | エスクロー残高・評価・GPU 属性検証 |

### 3.1 セッション無効化モデル（`isSessionInvalidated`）

アクセス/リフレッシュトークンは以下の **いずれか** の境界より前（同一秒含む）に
発行されたものを拒否する:

1. `passwordChangedAt` — パスワード変更時刻
2. `sessionsRevokedAt` — 全セッション失効時刻（リフレッシュ再利用検知・退会・ロール降格・**パスワード変更**）

未来タイムスタンプ（時計スキュー / DB 汚染）は `cutoff <= now` ガードで無視する
（未来 cutoff は全トークンを永続失効させてしまうため）。`iat` が NaN/Infinity の
トークンはフェイルクローズで拒否する。

---

## 4. API サーフェス（抜粋）

ベースパス `/api/v1`。グローバル JWT ゲートの保護下にある（公開エンドポイントを除く）。

| メソッド/パス | 認可 | 概要 |
|---------------|------|------|
| `POST /users/register`, `/users/login` | 公開 | 登録・ログイン（access+refresh 発行） |
| `POST /users/refresh` | refresh token | アクセストークン再発行（ローテーション） |
| `POST /users/logout` | JWT | jti 失効 + sessionsRevokedAt 更新 |
| `PUT /users/password` | JWT | パスワード変更（passwordChangedAt + sessionsRevokedAt） |
| `GET /gpus`, `GET /gpus/:id` | 公開 | 一覧・詳細（providerId/manualBlocks は非オーナーに非開示） |
| `POST /gpus`, `POST /gpus/:id/block` | JWT(owner/admin) | GPU 登録・メンテ枠ブロック |
| `DELETE /gpus/:id/block/:blockId` | JWT(owner/admin) | ブロック削除（id=UUID 検証、blockId=不在なら 404） |
| `POST /orders` | JWT | 注文作成（minRenterRating フロア適用） |
| `POST /orders/:id/accept` | JWT(GPU owner/admin) | 受諾（updateIf 内で GPU 所有権を再検証＝TOCTOU 封鎖） |
| `POST /payments/manual/approve/:id` | JWT(admin) | 手動承認（withLock + updateIf CAS） |
| `GET/POST/DELETE /api/profit-addresses` | JWT(admin) | 運営受取アドレス管理 |
| `GET /node-info`, `/channels` | JWT(admin) | Lightning ノード情報（未導入時 503） |
| `/master-auth/*` | OAuth+TOTP+メール | マスター3重認証 |
| `GET /metrics` | 公開 | Prometheus メトリクス |

---

## 5. セキュリティモデル

本プロジェクトは継続的な敵対的レビュー（probe 01〜50）でハードニングされている。
現行の主要なコントロール:

- **秘密情報の fail-fast**: 本番（`NODE_ENV==='production'`）で `JWT_SECRET` /
  `ENCRYPTION_KEY` / `SESSION_SECRET` 未設定なら起動失敗（`requireSecret`）。開発時は
  一時鍵を生成し警告。ハードコード秘密鍵フォールバックは全廃。
- **JWT**: HS256 固定（`algorithms:['HS256']`）でアルゴリズム混同（alg=none / RS256 すり替え）を防止。
  access+refresh の2種＋リフレッシュトークンローテーション、再利用検知で全セッション失効。
- **CSP（helmet）**: `default-src 'self'`, `script-src 'self'`（`unsafe-inline` 除去）,
  `frame-ancestors 'self'`, **`object-src 'none'`**, **`base-uri 'self'`**, **`form-action 'self'`**。
- **CORS**: ワイルドカード時は `credentials:false` を強制（仕様違反の `*`+credentials を回避）。
- **レート制限**: `TRUST_PROXY` を正整数 hop のみ受理し、XFF 偽装によるバイパスを防止。
- **決済の健全性**: 送金失敗は例外送出（`dummy-txid` を成功偽装しない）。invoice-poller は
  注文ステータスゲート＋クロスメソッド二重支払いガードを実装。
- **PII 最小化**: `sanitizeUser()` で password/apiKey/twoFactorSecret/jti 等を除去。
  peerid の `/admin/all` は email を返さない（peerId×email 相関による脱匿名化を防止）。
- **監査ログ**: SHA-256 ハッシュチェーンによる改竄検知付き append-only ログ。
- **TOTP**: 同一 30 秒ウィンドウ内のコード再利用を `lastTotpCounter` で拒否。
- **SSRF ガード**: `assertPublicUrl()` が DNS 解決して内部 IP 宛先を拒否。
- **外部 HTTP の DoS 耐性**: notifier の全 axios 呼び出しに `timeout` / `maxContentLength` を適用。

---

## 6. 長所（Strengths）

1. **深いセキュリティハードニング**: 50 回の敵対的 probe により、認証・認可・決済・PII の
   各層で OWASP 準拠のコントロールが積み上がっている。JWT alg 固定、CSP、XFF 偽装対策、
   監査ハッシュチェーンなど、実運用を意識した防御が揃う。
2. **明快なデータ原子性**: `updateIf`（CAS）＋ `withLock` ＋ `atomicWrite`（rename）で、
   単一プロセス内では二重承認・二重請求・ロストアップデートを防げている。
3. **回帰テストの厚み**: `tests/security/` に 43 本の probe テスト、統合テスト含め全 830 件
   （828 passed / 2 infra-skip）。設計判断がテストで固定されている。
4. **オプション依存の隔離**: libp2p / gRPC / Docker 等の重い依存を `core/services.js` で
   ガードし、未導入でも API が起動する。pre-alpha でも触れる土台がある。
5. **フェイルセーフ志向**: 秘密情報未設定で本番起動失敗、未知 iat の拒否、送金失敗の例外化など、
   「迷ったら安全側に倒す」設計が一貫している。

## 7. 短所（Weaknesses）

1. **単一プロセス前提**: `withLock` / `updateIf` の原子性はプロセスローカル。水平スケール時に
   競合防止が崩れる。JSON ファイル層も高頻度書き込みで I/O ボトルネック・破損リスクがある。
2. **ドキュメントと実態の乖離**: README / `improvement_checklist2.md` の `[x]` が実装を保証
   しない（自動生成テンプレ断片の残骸もあった）。新規参加者が誤認しやすい。
3. **インフラ層が未完**: P2P / 仮想 GPU / Lightning は本実装が薄く、`*-fixed.js` の孤立
   モジュールや未使用依存（knex/sqlite3/pg/ioredis）が残る。
4. **テスト実行の分断**: probe テストのみを個別実行していたため、統合テストとの **契約矛盾**
   （minRenterRating / block 404）が長く検出されなかった（本サイクルで是正）。
5. **可観測性の不足（一部改善）**: 構造化ログに加え相関 ID（`X-Request-Id`）を導入し
   （I-11）、アクセスログとエラーログを相関できるようになった。残課題は分散トレース
   （traceparent 伝播）と、`req.id` を全ログ呼び出しへ自動付与するコンテキスト伝播。

## 8. 改善点（Improvements）

### 本サイクルで実装済み ✅

| ID | 内容 | 根拠 |
|----|------|------|
| I-1 | 手動支払い承認を `withLock('payment:<id>')` で保護（ステータスゲート＋CAS の TOCTOU 封鎖） | probe49 |
| I-2 | パスワード変更で `sessionsRevokedAt` も同時更新（多層防御） | probe49 |
| I-3 | minRenterRating を「既知評価のみフロア適用＋未評価は `rejectUnratedRenters` でオプトイン拒否」に再設計（オンボーディングと Sybil 耐性の両立） | 契約矛盾の是正 |
| I-4 | block 削除の `blockId` を不透明文字列化（不在は 404、UUID 厳格化は GPU id のみ） | 契約矛盾の是正 |
| I-5 | CSP に `object-src 'none'` / `base-uri 'self'` / `form-action 'self'` を追加 | Qiita/Zenn の CSP ベストプラクティス調査（OWASP 準拠） |
| I-6 | TOTP カウンタ計算テストを window 整列タイムスタンプ化（フレーク除去） | probe48 安定化 |
| I-7 | パスワードを 8〜72 文字に制限（register/newPassword）。bcrypt の 72 バイト切り詰めによる「73文字目以降が無視され、先頭72バイトが同じ別パスワードが同一認証される」問題を防止。login は既存長パスワード救済のため上限なし | probe51 / Qiita・Zenn bcrypt 調査 |
| I-8 | ログのマスキングを (1) metadata splat（`logger.x('msg',{body})`）にも拡張し、(2) `json()` の **前段** に移動。旧実装は object 形式 message のみ、かつ json() の後に適用していたため、メタデータ内の password/apiKey/token が `combined.log` に素通りしていた（fail-open）。マスカーは循環安全・深さ制限付き | probe52 / Qiita・Zenn 構造化ログ調査 |
| I-9 | JSON リポジトリの書き込みチョークポイント（create/update/updateIf）で `__proto__`/`constructor`/`prototype` キーを除去（`stripDangerousKeys`）。プロトタイプ汚染の深層防御を全7リポジトリに一括適用 | probe53 / Qiita・Zenn プロトタイプ汚染調査 |
| I-10 | 通知設定 `enabled` を任意キー許可（`pattern(/.*/)`）から消費側が実際に参照する6チャネルの明示スキーマに厳格化。Joi 既定の unknown:false で未知キー（`constructor` 等）を 400 拒否。`notification-settings.json` はリポジトリ層の `stripDangerousKeys` を経由しない別保存経路のため、入力スキーマ側で塞ぐ | probe54 / Qiita・Zenn 任意キー調査 |
| I-11 | リクエスト相関 ID を強化（D-2 の一部）。`X-Request-Id` を (1) 上流の安全な値があれば再利用、(2) 不正・過長値はフォールバックで UUID 採番、(3) レスポンスヘッダに反映、(4) エラーログにも `requestId` を付与してアクセスログと相関 | probe55 / Qiita・Zenn request-id 調査 |

### フォローアップ（未実装）

| ID | 内容 | 優先度 |
|----|------|--------|
| D-1 | データ層を PostgreSQL（または Prisma）へ移行し、マルチプロセス・トランザクション・行ロックを獲得 | 高 |
| D-2 | （部分実装 I-11）残: 分散トレース（W3C Trace Context / traceparent 伝播）と APM 連携、`req.id` を全 `logger.*` 呼び出しへ自動付与する AsyncLocalStorage コンテキスト | 中 |
| D-3 | `npm audit` の CI 統合と依存の継続的脆弱性チェック（Zenn「Node.js 脆弱性チェック」参照） | 中 |
| D-4 | 孤立モジュール（`*-fixed.js`）の削除と未使用依存の整理、サービスの DI 化 | 中 |
| D-5 | CSP nonce 導入（インラインスクリプトが必要になった場合）と CSP レポート収集 | 低 |
| D-6 | ドキュメント是正（README / checklist の実態反映、ARCHITECTURE.md 整備） | 低 |

---

## 9. 参考（Qiita / Zenn 調査）

CSP・JWT・レート制限・CORS のハードニング方針は以下の日本語技術記事の整理と
OWASP の指針に基づく:

- [ExpressでHelmet（v6.0.1）を使うと付与されるHTTPヘッダ（Zenn）](https://zenn.dev/s1r_j/articles/6a8e2d593bfc08e21392)
- [ExpressでHelmetを使ってContent Security Policyを設定する方法（Zenn）](https://zenn.dev/tatsuyasusukida/articles/express-content-security-policy)
- [超簡単 Node.js 脆弱性チェック（Zenn）](https://zenn.dev/kazukix/articles/nodejs-vulnerability-check)
- [【セキュリティ】JWTで発生する「機密情報漏えい」の典型パターン（Qiita）](https://qiita.com/nozomi2025/items/ab5aa51275a53a07ed20)
- [ExpressにおけるRate Limitの実装ガイド（Qiita）](https://qiita.com/GorillaSwe/items/5e78d8f3cd35420b35ef)
- [IAMセキュリティ: 基礎から高度な保護まで（ベストプラクティス 2025）（Qiita）](https://qiita.com/logto/items/1ae6c4fbb4853f9fcb34)
- [Bcryptでパスワードのハッシュ化と照合を行う（Zenn）](https://zenn.dev/groove_harbor/scraps/d54f4bc5785341)
- [Expressでのエラーハンドリング ベストプラクティス（Qiita）](https://qiita.com/nyandora/items/cd4f12eb62295c10269c)
- [Node.jsでwinstonを使ってログを収集する方法（Zenn）](https://zenn.dev/tatsuyasusukida/articles/nodejs-winston-logging)
- [JavaScriptで始めるユーザー認証：パスワードの安全な管理とbcryptの活用（Qiita）](https://qiita.com/arihori13/items/61aaf2c223dfd99a87f0)
- [JavaScriptのプロトタイプ汚染攻撃対策は難しい（Qiita）](https://qiita.com/shellyln/items/af200a1953991de1698d)
- [JavaScriptのPrototype Pollution（プロトタイプ汚染）について（Zenn）](https://zenn.dev/wasabina67/articles/52-denk75fn30miqt9u)
- [正規表現の落とし穴（ReDoS - Regular Expressions DoS）（Qiita）](https://qiita.com/prograti/items/9b54cf82a08302a5d2c7)
- [【Node.js】ログにリクエストIDを記録する（Qiita）](https://qiita.com/satoshio/items/9f3ad092a9ea690fcd60)
- [リクエストIDを追加して調査を快適にする（Zenn）](https://zenn.dev/spacemarket/articles/send-request-id-from-gateway)
