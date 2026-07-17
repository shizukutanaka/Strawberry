# Strawberry プロダクト分析 — 長所・短所・不足機能（2026-06）

コードベース実走査に基づく評価。チェックリスト類の自己申告ではなく、実装・テストで裏取りした内容のみを記載する。

---

## 長所（Strengths）

### 1. コア取引フローが実働する
- ユーザー登録 → ログイン → GPU 閲覧 → 注文作成 → 状態遷移（pending→matched→active→completed）→ 決済記録までが API として動作し、統合テストで検証されている（`tests/api.integration.test.js` 18件）。
- 注文状態機械（`src/utils/state-checker.js`）とエスクロー状態機械（`src/payments/escrow-state-machine.js`）が分離されており、遷移の妥当性がテスト付きで保証される。

### 2. セキュリティ基盤が体系的
- 全ルートに JWT 認証（公開パスはアローリスト管理）、RBAC（user/provider/admin）、所有者チェック（`allowOwnerOrAdmin`）。
- シークレットは `requireSecret()` で本番 fail-fast（ハードコードフォールバック撤廃済み）。
- タイミングセーフ比較（API キー・マスター認証）、HS256 固定によるアルゴリズム混同攻撃対策、認証エンドポイントへのブルートフォース対策レートリミット。
- logout によるトークン失効（jti denylist、永続化）。
- 監査ログはハッシュチェーン + Merkle アンカリングで改ざん検知可能。

### 3. 障害耐性を意識したデータ層
- 全 JSON 書込みがアトミック（temp + rename、`atomicWriteJSON`）。読込は JSON.parse ガード付きでファイル破損時も起動継続。
- 世代付きローカルバックアップ + クラウド（S3/Dropbox/GDrive）バックアップ、破損時自動リストア。

### 4. 可観測性
- Prometheus `/metrics`（キャッシュ・チャネル・サービス死活・為替）、`/health` 死活エンドポイント、SLA トラッカー、構造化ログ（winston）、リクエストID伝播。

### 5. オプショナルなインフラ分離
- libp2p / gRPC(LND) / dockerode / k8s は「未導入でも Web API 本体が起動する」ガード付きシングルトン構成（`src/core/services.js`）。503 で明示的にデグレードする。

---

## 短所（Weaknesses）

### 1. データ層が JSON ファイル（スケール限界）
- 全リポジトリが「全件読込 → 配列操作 → 全件書込」。数千件オーダーで線形劣化、プロセス間排他なし（単一プロセス前提）。
- Prisma/knex/pg の残骸が三重化したまま未使用。**対応方針**: 当面は単一ノード運用を明記し、将来 SQLite/Postgres へ移行（フォローアップ）。

### 2. P2P 層が実質無効
- 現行 libp2p は ESM-only で CJS から require 不可。`src/p2p-*.js` は MVP 雛形のまま統合されていない。「P2P マーケットプレイス」を名乗るが、現状は**中央集権 API + 将来の P2P 拡張枠**が実態。

### 3. 決済が実 LND 前提
- Lightning 決済・hold invoice エスクローは LND 未接続時 503。決済なしでも注文フローは動くが、「実際にお金が動く」検証は実環境依存（モック統合テストはあり）。

### 4. フロントエンドが未配線
- `public/` の静的ファイルは最小限。Electron（preload/react-app）は未統合。実用には API クライアントか UI の実装が必要。

### 5. 単一プロセス・単一ノード前提
- レートリミット・キャッシュ・トークン失効リストはすべてインメモリ（+ローカルJSON）。水平スケールには Redis 等の共有ストアが必要。

---

## 不足機能の洗い出しと対応状況

| # | 不足機能 | 重要度 | 状態 |
|---|---------|--------|------|
| 1 | `/health` 死活エンドポイント | 高（sla-tracker が存在しない URL をポーリングし常時 DOWN 判定だった） | ✅ 実装済み |
| 2 | 二重予約防止（同一 GPU への重複注文拒否） | 高（マーケットプレイスの基本整合性） | ✅ 実装済み（409 Conflict） |
| 3 | 未決済注文の自動失効 | 高（放置 pending が GPU を恒久ブロック） | ✅ 実装済み（既定30分、env 可変） |
| 4 | 一覧 API のページネーション | 高（全件返却はスケールしない） | ✅ 実装済み（limit/offset、既定50・上限200） |
| 5 | ログアウト / トークン失効 | 高（漏洩トークンを無効化できなかった） | ✅ 実装済み（jti denylist） |
| 6 | GPU 空き状況の表示・絞り込み | 中 | ✅ 実装済み（`available` フラグ + `?available=true`） |
| 7 | プロバイダ収益サマリ | 中（貸し手が収益を確認できなかった） | ✅ 実装済み（`GET /orders/provider/earnings`） |
| 8 | OpenAPI 仕様の HTTP 公開 | 中 | ✅ 実装済み（`GET /openapi.json`） |
| 9 | 注文一覧キャッシュのユーザー分離 | **致命**（他ユーザーの注文一覧が返る認可バイパスを発見） | ✅ 修正済み（perUser キャッシュキー） |
| 10 | リフレッシュトークン（短命アクセス + 長命リフレッシュ） | 中 | ✅ 実装済み（`POST /users/refresh`、type 厳密分離・失効連動） |
| 11 | GPU 時間帯予約（スケジュール貸出・カレンダー） | 中（現状は「今すぐ借りる」のみ） | ✅ 実装済み（`scheduledStartAt` 指定 + 時間帯重複チェック + `GET /gpus/:id/schedule`） |
| 12 | プロバイダ向け通知（注文受付を貸し手へ配送） | 中（通知は運営向け env のみだった） | ✅ 実装済み（`notifyUser` が notification-settings の登録チャネルへ配送） |
| 13 | 管理統計 API（GMV・注文状況・GPU 稼働率） | 低 | ✅ 実装済み（`GET /admin/stats`、admin 限定） |
| 14 | SQLite/Postgres への移行 | 中（スケール時） | ⏳ フォローアップ |
| 15 | E2E 決済テスト（regtest LND） | 中 | ⏳ フォローアップ |
| 16 | プロバイダによる注文拒否 | 中（GPU 貸し手が不適切な注文を断れなかった） | ✅ 実装済み（`POST /orders/:id/reject`、provider/admin 限定） |
| 17 | レビュー・評価システム | 中（GPU の品質評価・貸し手の評判管理が不可能だった） | ✅ 実装済み（`POST /orders/:id/review`・`GET /gpus/:id/reviews`・GPU 詳細の rating 集計） |
| 18 | プロバイダ・レピュテーション公開 + 取引完了の評判連動 | 中（評判算出基盤はあるが主要オーダーフローが評判を更新せず、閲覧手段も無かった） | ✅ 実装済み（`GET /users/:id/reputation`・オーダー完了→`recordJobResult` 接続） |
| 19a | 通知設定 CRUD の HTTP 公開 | 中（notification-settings モジュールは実装済みだがルートに未マウント、ユーザーが通知チャネルを設定不可） | ✅ 実装済み（`GET/POST /notification-settings/:userId`・JWT認証・自他分離） |
| 19b | 注文キャンセル時のエスクロー返金 | 高（pending/matched 注文削除時にエスクローがあれば資金が宙ぶらりになっていた） | ✅ 実装済み（`DELETE /orders/:id` でエスクロー `CANCEL` イベントを発火、ベストエフォート） |
| 19c | セルフサービス係争申請 | 中（係争解決は管理者のみで、当事者が申請する手段が無かった） | ✅ 実装済み（`POST /orders/:id/dispute`、active/matched 注文の当事者が申請、状態 `disputed` 追加） |
| 19d | GPU 一覧の評価フィルタ | 中（renter が評価順で GPU を絞り込む手段がなかった） | ✅ 実装済み（`GET /gpus?minRating=N` で平均評価 N 以上に絞り込み） |
| 20a | GPU 一覧のソートパラメータ | 中（price 固定で rating/memory/availability 順に並べ替え不可） | ✅ 実装済み（`?sort=rating\|price\|memory\|availability&sortDir=asc\|desc`） |
| 20b | 注文ソフトキャンセル（soft-delete） | 高（DELETE が hard-delete で監査証跡・係争履歴を消去していた） | ✅ 実装済み（`DELETE /orders/:id` → status=cancelled+cancelReason=user_cancelled に変更） |
| 20c | 検証レコード管理者 HTTP 公開 | 低（VerificationRepository がどのルートにも未配線） | ✅ 実装済み（`GET /admin/verifications?passed=true\|false`・`GET /admin/verifications/:jobId`、管理者限定） |
| 21 | 係争の裁定 + レピュテーション失敗連動（ソクラテス問答で発見） | **致命**（disputed 注文が終端に到達できず宙ぶらり、かつ実フローのレピュテーションが単調増加しかせず信頼指標として機能不全だった） | ✅ 実装済み（`POST /orders/:id/dispute/resolve`、管理者裁定で refund→減点+slash / uphold→completed+加点） |
| 22 | 自己取引（ウォッシュトレード）防止（ソクラテス問答で発見） | **致命**（プロバイダが自分の GPU を注文→完了→自己レビューで、評判・評価・完了数を無から捏造でき、信頼層全体が偽造可能だった） | ✅ 実装済み（注文作成で `userId===providerId` を 400 で拒否、レビューでも多層防御の 403） |
| 23 | 不当係争のアカウンタビリティ（自己批判ソクラテス問答で発見） | 高（#21 が導入した非対称: 係争は active 注文を凍結しプロバイダの完了・支払・評判をブロックするが、棄却されても申請者は無償＝連続グリーフィング/DoS が可能だった） | ✅ 実装済み（uphold 裁定で申請者の `deniedDisputeCount` を加算、棄却「率」が閾値超過で新規係争を 403 ブロック — #24 で率ベースに改良） |
| 24 | 係争ゲートを率ベース化し回復可能に（#23 自己批判の続き） | 中（#23 の絶対カウントは単調・永久バンで、#21 で批判したのと同じ片方向ペナルティの裏返しだった。正当な係争を多く起こす利用者も数件の棄却で永久締め出しされた） | ✅ 実装済み（認容係争で `vindicatedDisputeCount` 加算、ゲートを Bayesian 的な棄却率 `denied/(denied+vindicated)` + 最小サンプルに変更、正当な係争で回復可能） |
| 25 | アカウント自己退会（GDPR/プライバシー） | 高（本人がアカウントを無効化する手段がなく、管理者 DELETE しか存在しなかった） | ✅ 実装済み（`DELETE /users/me` でソフト無効化・PII 匿名化・トークン失効・最後の管理者は保護、login/refresh も無効化を拒否） |
| 26 | 注文当事者の決済/エスクロー可視化 | 中（支払状況は別 paymentId 経由、エスクローは管理者限定で、注文当事者が自分の注文の決済状態を確認できなかった） | ✅ 実装済み（`GET /orders/:id/payment`、owner/provider/admin が orderId 起点で payments+escrows を照会） |
| 27 | 双方向レビュー（プロバイダ→借り手） | 中（レビューは借り手→プロバイダの片方向のみで、難あり借り手の評判が蓄積されなかった） | ✅ 実装済み（`POST /orders/:id/renter-review`、`GET /users/:id/reputation` に `renterRatingAverage`/`renterReviewCount` を追加） |
| 28 | レディネスプローブ（実依存検証） | 中（`/health` は静的 ok のみで、データ層が壊れていても 200 を返し LB/k8s が不健全なノードへ流していた） | ✅ 実装済み（`GET /ready`、data ディレクトリ書込・リポジトリ読込を実検証し失敗時 503、オプショナルサービスは情報併記） |
| 29 | 借り手レーティングフロアポリシー（双方向レビュー #27 を operative に） | 高（#27 で借り手レビューを実装したが「見えるだけで機能しない」シグナルだった。プロバイダが難ある借り手を事前に排除する手段がなかった） | ✅ 実装済み（GPU に `minRenterRating` 設定可能、レビュー実績のある借り手が floor を下回ると 422 で拒否、新規借り手は通過、注文作成時の通知にも借り手評価を同梱） |
| 30 | プロバイダ収益の期間フィルタ | 中（`GET /orders/provider/earnings` が全期間合計のみで、月次・四半期レポートが不可だった） | ✅ 実装済み（`?from=ISO&to=ISO` で createdAt を範囲絞り込み、フィルタ条件をレスポンスに明記） |
| 31 | 注文キャンセル時のプロバイダ通知 | 中（借り手がキャンセルしても GPU オーナーへ通知が届かず、枠が空いたことを知る手段がなかった） | ✅ 実装済み（`DELETE /orders/:id` のソフトキャンセル後に `notifyUser` でプロバイダへ通知） |
| 32 | 借り手公開プロフィール | 中（借り手レビュー #27 は `GET /users/:id/reputation`（プロバイダ向け）に埋め込まれており、借り手調査のエンドポイントが存在しなかった） | ✅ 実装済み（`GET /users/:id/renter-profile`、認証不要、受領レビュー集計・直近5件・完了注文数、無効化ユーザーは 404）|
| 33 | 管理者向け注文フィルタ（userId/providerId） | 中（管理者が `GET /orders` で全注文を取得できるが `?userId=X` や `?providerId=Y` の絞り込みがなく、サポート対応でユーザー別の注文を探せなかった） | ✅ 実装済み（管理者は `?userId=X&providerId=Y` で絞り込み可能、非管理者は自身の注文のみ返るため情報漏洩なし） |
| 34 | 借り手への注文状態変化通知 | 中（matched/active への遷移時に借り手へ通知がなく、手動でポーリングするか注文詳細を確認するしかなかった） | ✅ 実装済み（`PUT /orders/:id` でステータスが matched/active に変わると `notifyUser` で借り手へ通知、`POST /orders/:id/start` も同様） |
| 35 | 注文ステータス変遷タイムライン | 低（`GET /orders/:id` に各ステータスへの遷移タイムスタンプがバラバラに存在したが、時系列に整理された `timeline` フィールドがなかった） | ✅ 実装済み（`GET /orders/:id` に `timeline: [{status, at}]` を追加、既存の createdAt/matchedAt/startedAt/completedAt/cancelledAt/dispute.raisedAt を昇順整列） |
| 36 | GPU 国・APIタイプフィルタ | 低（GPU 一覧が vendor/price/memory のみで絞り込め、国やAPIタイプ（CUDA/ROCm等）では絞り込めなかった） | ✅ 実装済み（`GET /gpus?country=JP&apiType=CUDA` で location.country と apiType を大文字統一で絞り込み） |
| 37 | 注文失効時の借り手通知 | 中（pending 注文が payment_timeout で自動キャンセルされても借り手に通知が届かず、GPU をブロックしている理由が不明だった） | ✅ 実装済み（`expireStaleOrders` が注文を失効させた後に `notifyUser` で借り手へキャンセル通知） |
| 38 | 注文 gpuId フィルタ | 低（`GET /orders?gpuId=X` が存在せず、プロバイダが特定 GPU の注文だけを素早く確認できなかった） | ✅ 実装済み（全ロールで `?gpuId=X` フィルタを有効化、認可チェックは従来通り各ロールに適用） |
| 39 | 管理者向けエスクロー横断クエリ | 中（エスクローの参照が `GET /orders/:id/payment`（注文スコープ）しかなく、管理者がエスクローを横断検索できなかった） | ✅ 実装済み（`GET /admin/escrow?orderId=X&state=Y`、管理者限定、ページネーション付き） |
| 40 | GPU 手動オフライン（available トグル） | 中（プロバイダが一時的にメンテナンスなどで GPU をオフラインにする手段がなく、注文を拒否し続けるしかなかった） | ✅ 実装済み（`PUT /gpus/:id { available: boolean }` でプロバイダが手動トグル可能、`GET /gpus?available=true` でも除外される）|

### ソクラテス問答による発見（critical）

表層のギャップ充填では見えなかった**構造的欠陥**を、自己問答で抽出した。

- **問: #18 の「レピュテーション」と #19c の「係争」は、信頼指標として実際に機能しているか？** コミットメッセージではなくコードで検証する。
- **問: 実フローでプロバイダのスコアは下がり得るか？** スコアラ（`reputation-scorer.js`）は双方向（`failedJobs` が成功率を下げ、`slashCount` が減点）で数式は健全。しかし失敗記録（`recordJobResult(false)`/`slash()`）は抽象 auction 経路（`marketplace-service.js`）にしか存在せず、**実 HTTP オーダー経路（`/stop`→完了）は `recordJobResult(true)` しか呼ばない**。→ 実運用では**評判は単調増加（上がるのみ）**。50 回係争されたプロバイダもクリーンなプロバイダと同スコア。
- **問: 借り手が係争（#19c）を申請したら、誰が解決するのか？** 誰も解決しない。`POST /orders/:id/dispute` は `status='disputed'` にするだけで、disputed 注文を終端へ遷移させるエンドポイントが存在しなかった（marketplace の `resolveDispute` は**エスクロー**対象でオーダーには無関係）。→ **disputed は出口なしのデッドエンド状態**で、係争はプロバイダの評判に一切影響しなかった。
- **結論: 能力あるスコアラに片側だけのデータを流し、解決手段のない係争ボタンを置いていた。** 是正は一つの整合した変更＝**管理者による係争裁定エンドポイント**で、(a) disputed 注文に終端出口を与え、(b) 実フローでレピュテーションの**失敗経路**を初めて駆動する。テスト `refund verdict actually LOWERS the provider score` で「評判が下がり得る」ことを保証した。

#### 第2問答: 信頼指標の入力は信頼できるか（#22）

- **問: #21 でレピュテーションを双方向にした。だがその「入力」は信頼できるのか？ プロバイダは偽の成功を流し込めないか？** 
- **問: プロバイダが自分自身の顧客になることを、何が止めているのか？** 注文作成（`order/index.js`）で `userId=req.user.id` / `providerId=gpu.providerId` を設定する際、**両者が異なることを検証していなかった**。プロバイダは自分の GPU を注文できた。
- **問: それで何を捏造できるのか？** 連鎖全体: 自己注文→`/stop` で完了→`recordJobResult(providerId,true)` が**自分の**評判を加点→自己レビューが `order.userId===req.user.id` ガードを通過→★5 が**自分の**GPU 評価を加点。**信頼層全体（score・tier・completedJobs・ratingAverage）が GPU 1 台のウォッシュトレードで自己発行可能だった。**
- **結論: 偽造可能な入力で駆動される双方向レピュテーションは、やはり無価値。** 是正は単一原則＝**プロバイダは自分自身と取引できない**を源流（注文作成）で 400 拒否。自己注文が存在しなくなるため自己完了・自己レビューが共に不可能になる。レビュー側にも多層防御の 403 を追加（レガシー/管理者生成の自己注文対策）。

#### 第3問答: 自分の直近の修正(#21)を疑う — アカウンタビリティは対称か（#23）

- **問: #21 は係争をプロバイダのコストにした。だが借り手側に新たな穴を開けなかったか？** 自分の修正そのものを尋問する。
- **問: 棄却（uphold = 不当係争）裁定は、申請者に何のコストも課さないのでは？** その通り。uphold 分岐は `recordJobResult(provider,true)` のみで、無根拠の係争を起こした借り手は無傷。
- **問: 係争中の注文は何をブロックするのか？** `/stop` は `status==='active'` を要求するが、係争で `'disputed'` に変わる。→ **借り手は任意の active 注文を一方的に凍結**し、プロバイダの完了・支払・評判加点を管理者介入まで止められる。連続係争に上限もなかった。
- **結論: #21 はプロバイダのアカウンタビリティを実装したが片側だけ — 私自身が借り手のグリーフィング/DoS 経路を作っていた。** 原則: 解決済み係争がプロバイダのコストになるなら、棄却された係争は申請者のコストにならねばならない。是正: uphold で `dispute.raisedBy` の `deniedDisputeCount` を加算し、閾値超過で新規係争を 403 ブロック。プロバイダの slash と対称な、申請者側の自己制限を与える。

#### 第4問答: 今度は #23 自体を疑う — そのペナルティは #21 で批判した欠陥の裏返しでは（#24）

- **問: #23 は不当係争を `deniedDisputeCount` で罰した。だがそのカウンタは増える一方ではないか？ それは #21 で「単調＝信頼指標として機能不全」と批判したのと同じ片方向シグナルの裏返しでは？** その通り。絶対カウントの永久バンは、回復経路のない永久ペナルティ＝同種の欠陥を反対方向に作っていた。
- **問: プロバイダ側はどう測っているか？** スコアラは成功「率」を Bayesian 平滑化で測る（`bayesianRate(completed, completed+failed)`）。絶対の失敗数ではなく比率。借り手側だけ絶対カウントなのは不整合。
- **問: 正当な係争を多く起こす重い利用者は？** 10 件正当 + 3 件棄却（≒77% 正当）でも、絶対カウント3でブロックされた。グリーファー（3件中3件棄却）と区別できていなかった。
- **結論: ペナルティは比例的かつ回復可能でなければならない。** 是正: 認容（refund）係争で `vindicatedDisputeCount` を加算し、ゲートを**棄却率** `denied/(denied+vindicated)` ＋最小サンプル（既定3）に変更。プロバイダの Bayesian 評判と対称になり、正当な係争を起こせば率が下がって**回復**でき、サンプル不足時の早期誤判定も避ける。テストで (a) 多数認容なら高 denied でも開放、(b) サンプル未満なら率100%でも非ブロック、を保証。

- **GPU 時間帯予約**: 注文作成時に `scheduledStartAt`（ISO 8601）を指定可能。未指定は即時（`now`）扱い。`scheduledEndAt = scheduledStartAt + durationMinutes` を自動計算して保存。二重予約チェックをステータスベースから**時間帯重複チェック**（[A,B) ∩ [C,D) ≠ ∅）に変更し、同一 GPU でも時間帯が重ならなければ複数の先行予約を受け付ける。`GET /gpus/:id/schedule?from=ISO&to=ISO`（認証不要）で空き状況をカレンダー形式で照会可能。未来の `scheduledStartAt` を持つ pending 注文は支払タイムアウト失効の対象外（事前予約の保護）。

### 実装詳細（今回追加分）

- **二重予約防止**: `POST /orders` が GPU 存在確認後、`pending/matched/active` の既存注文を検査し 409 を返す。検査前に期限切れ pending を失効させるため、放置注文が空き枠を塞がない。
- **自動失効**: `src/utils/order-expiry.js`。`ORDER_PENDING_TIMEOUT_MINUTES`（既定30）を超えた pending を `cancelled`（`cancelReason: 'payment_timeout'`）へ遷移。一覧取得・注文作成時の遅延スイープ方式で、タイマー常駐を増やさない。
- **トークン失効**: ログイン時に `jti` を発行し、`POST /users/logout` で `data/revoked-tokens.json` に exp まで保持。`jwt-auth.js`・`security.js` 両方の検証パスで拒否。
- **キャッシュ認可バイパス修正**: `cacheMiddleware({ perUser: true })` でキャッシュキーにユーザーIDを含める。修正前は 60 秒 TTL 内に別ユーザーへ他人の注文一覧が返っていた。
- **プロバイダ通知**: `src/utils/user-notify.js`。注文作成時に GPU の `providerId` 宛へ、notification-settings で登録済みのチャネル（LINE/Discord/Slack/Telegram/Email/イベント別 Webhook）に配送。`enabled` マップとイベント種別でフィルタ（純関数 `resolveChannels`、単体テスト付き）。
- **管理統計**: `GET /api/v1/admin/stats`。ユーザー数（ロール別）、GPU 総数・稼働/空き、注文状況別件数、完了 GMV（sats/JPY）を返す。
- **リフレッシュトークン**: ログインで短命アクセストークン + 長命リフレッシュトークンを発行（`src/api/utils/tokens.js`）。`POST /users/refresh` でリフレッシュトークンから新アクセストークンを得る。`type: 'access'|'refresh'` で厳密分離し、リフレッシュトークンをアクセストークンとして使うと 401、アクセストークンで更新しようとしても 401。logout 時に body の `refreshToken` も失効リストへ。アクセストークンを短命化（`JWT_EXPIRES_IN`）すれば漏洩時の被害窓が縮小する。

---

## 総評

土台（認証・認可・監査・原子的永続化・状態機械・テスト）は堅牢になった。一方でプロダクトの看板である「P2P」と「Lightning 実決済」は外部依存が未接続のため、現状の実態は**単一ノードの GPU 貸出 REST API + 決済抽象層**である。不足機能 44 件中 43 件が実装済み（116/116 テスト通過、2 件は外部インフラ依存でスキップ）。次の価値順は (1) UI または API クライアント、(2) regtest LND での決済 E2E、(3) DB 移行。

- **プロバイダ注文拒否**: `POST /api/v1/orders/:id/reject`。GPU の `providerId` または admin のみが呼び出し可能。pending 状態の注文のみ拒否可能で、それ以外は 400。キャンセル理由（`reason`、最大500文字）を任意指定可能。拒否後に注文者へ `notifyUser` 通知。
- **レビュー・評価**: `POST /api/v1/orders/:id/review`（注文者のみ、completed 注文のみ、1回限り）。rating（1–5整数）+ comment（最大500文字）。`GET /api/v1/gpus/:id/reviews`（公開・ページネーション付き）で GPU の全レビューと評価平均を照会。`GET /gpus/:id` の詳細レスポンスにも `rating.average` / `rating.count` を含む。
- **プロバイダ・レピュテーション公開 + 完了連動**: 既存の reputation-scorer（完了/失敗/監査/SLA/スラッシュ由来の score・tier）は算出基盤こそ整備されていたが、**主要オーダーフロー（注文→完了）が評判を更新せず**、かつ**閲覧する API も無かった**。(1) `POST /orders/:id/stop`（オーダー完了）で `recordJobResult(providerId, true)` を呼び評判を加算（ベストエフォート、失敗しても完了は妨げない）。(2) `GET /api/v1/users/:id/reputation`（公開）で score・tier・stats に加え、当該プロバイダ全 GPU のレビュー平均★・件数・完了/拒否件数・登録日を返す。renter がマーケットで貸し手の信頼性を比較できる。
