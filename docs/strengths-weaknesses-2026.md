# Strawberry 長所・短所・改善点監査（2026-10）

コードベース実査に基づく網羅的監査。評価軸は「P2P GPU マーケットプレイス＋Lightning エスクロー」という
製品の原子機能に対して、実装がどれだけ整合しているか。各項目は `src/`・`tests/`・`scripts/` の
実コードを根拠とする（open PR で未マージの改善は短所側に「既知・PR済み」と明記）。

## 長所（50）

### 決済・エスクロー（1-12）

1. **Hold invoice エスクロー**: 資金を運営が受領せずロックだけする LN hold invoice 方式。非custodial で規制・盗難リスクが低い。
2. **エスクロー状態遷移の CAS 化**: `updateIf` による compare-and-swap で `paid → refunded` 等の前提条件付き遷移を実装。並行更新の lost-update を防止。
3. **タイムアウト注文の HELD 解放**: 期限切れ注文のエスクロー hold を自動解放（資金ロック永久化の防止）。
4. **btc-onchain の fail-closed CAS**: エスクロー更新失敗時に課金を進めない（二重課金防止）。
5. **LND unary RPC deadline**: `service_config` の `methodConfig.timeout`（既定60s）で gRPC の無限滞留を遮断。
6. **LND イベントストリーム再接続の単一タイマー化**: reconnect の多重化を cancel+指数バックオフで防止。
7. **エスクロー資金移動のハッシュ連鎖監査ログ**: 資金イベントが改竄検知可能なチェーンで記録される。
8. **MockLnAdapter**: LND 非依存のテスト/開発経路があり IF 契約がユニットテストで固定済み。
9. **支払いリマインダーのスパム対策**: 送信条件・頻度制御がテスト固定済み（`remindPendingPayments`）。
10. **エスクロー失敗時の内部エラー非露出**: `e.message` を応答から除去（内部情報漏洩の遮断）。
11. **order-pricing の金額不変条件テスト**: 価格ロック・端数処理・JPY 換算がユニットテストで固定。
12. **profit-addresses の管理**: 利益送金先ストアを `data/` ルートへ整理し同梱シードアドレスを除外。

### セキュリティ（13-30）

13. **SSRF guard の IPv6 網羅**: `fe80::/10` 全体・IPv4 埋め込み遷移機構（`::ffff:` 等）を遮断。
14. **共有 ssrf-guard + 登録時 DNS 事前検証**: notification-settings での SSRF 検査が一元化。
15. **/metrics Bearer の timing-safe 照合**: 秘密値比較が `safe-compare` 共有ヘルパーへ集約。
16. **アカウント退会の再認証**（OWASP re-authentication 準拠）。
17. **マスター昇格セッションの絶対 TTL**（既定30分）。
18. **TOTP 隣接ウィンドウのリプレイ遮断**: 受理コード記録により同一コード再利用を拒否。
19. **token denylist のクロスプロセス失効伝播**: stat ゲート再読込で他プロセスの失効も反映。
20. **sanitizeSensitiveFields の深度上限+循環参照ガード**: DoS 防止。
21. **devRequestLogger の資格情報マスク**: キー名ベースでボディ内機密を伏字化。
22. **監査ログ URL の生クエリ除去** + **ログ内 URL の機密クエリパラメータマスク**。
23. **検証監査抽出の HMAC 鍵付き化**: プロバイダが抽出位置を予測不能（選択的チート防止）。
24. **アテステーション mandatory チェックの fail-closed 化**: フィールド欠落を拒否側へ。
25. **vGPU プロビジョニングのシェル/マニフェスト注入サニタイズ**。
26. **オークション入札の権威フィールド除去**: クライアント指定の authority を受理しない。
27. **security.txt（RFC 9116）配信**、`/.well-known/` 配線済み。
28. **RFC 9745 Deprecation ヘッダー**（非推奨ルート）・**Retry-After**（RFC 9110、429 応答）。
29. **レート制限カウンタ Map の上限化**: `_loginFailures`/`_totpIpMap` の無制限増殖を防止。
30. **ログ肥大化防止**: `MAX_AUDIT_LOG_MB` の NaN ガード + 深度制限 + mkdir 一度のみ。

### 性能・データ層（31-38）

31. **JSON リポジトリの stat 指紋ゲート共有読み込みキャッシュ**: mtime+size 未変化なら再パースせず。
32. **atomicWrite + 孤児 .tmp の amortized sweep**: クラッシュ残骸の回収。
33. **認証パスの users.json stat ゲートキャッシュ**: リクエスト毎の全量パースを回避。
34. **invoice-poller の stat ゲート早期 return**: 静寂時の全量パースをゼロに。
35. **N+1 ファイル I/O の Map 化**: marketplace stats・provider stats・gpu-monitor tick で一括取得。
36. **provider-uptime の pending 差分+一括 flush**: 書き込みのバッチ化。
37. **createMany/deleteMany バッチプリミティブ**（#62 は closed だが Map 化は #64 でマージ済み）。
38. **Jest ワーカー別データ分離**: スイート並列化で 86s→30s。

### 信頼性・運用（39-50）

39. **タイマー健全化の徹底**: service-monitor・lightning・gpu-monitor・perf-optimizer で unref+stop+二重起動ガード。
40. **graceful shutdown の 30s 強制タイマー**: 接続ドレインに上限。
41. **`require.main === module` ゲート**: テスト時に listen/タイマー/プロセスガードが起動しない設計。
42. **withLock キー単位 mutex**: RMW の直列化、並行契約がテスト固定済み。
43. **resilientNotify のフェイルオーバー**: 通知経路の冗長化、契約テスト済み。
44. **appendRotated 規約**: `appendFileSync` 系ログの 1 世代ローテーション統一（ディスク枯渇防止）。
45. **定期バックアップ配線**: `BACKUP_INTERVAL_HOURS` opt-in で `data/*.json` を保存。
46. **/health + Docker HEALTHCHECK**: 疎通確認経路が実装済み。
47. **OTel ゲーティングの不変条件テスト**: 計装の有効/無効境界を固定。
48. **RED メトリクスミドルウェア**: rate/error/duration を Prometheus 化。
49. **asyncHandler 規約への統一**: 裸 async ハンドラの rejection 迂回を解消。
50. **errorMiddleware の headersSent ガード**: 二重送信防止。

## 短所（50）

### データ・整合性（1-10）

1. **JSON ファイル「DB」**: プロセス間の書き込みロックなし。複数プロセス/ワーカーで破損リスク（#29 open）。
2. **インデックス不在**: クエリは全件走査。stat キャッシュで緩和されるも本質は O(ファイルサイズ)。
3. **メモリ上限**: コレクション全体をメモリ展開する設計はデータ増大で破綻する。
4. **リポジトリ横断トランザクション不在**: order+payment+escrow の複数ファイル更新は非原子（途中クラッシュで不整合）。
5. **Prisma/Postgres 経路は aspirational**: テストが describe.skip で恒久スキップ。スキーマ二重化の漂流リスク。
6. **バックアップはファイルコピーのみ**: 復元時の整合性検証・ポイントインタイム復旧なし。
7. **セッション/揮発 Map はメモリ内**: プロセス再起動で揮発する状態が複数箇所。
8. **冪等性キー不在**: `POST /orders` のリトライで二重注文が起き得る（#26 open）。
9. **設定ファイルのスキーマ検証なし**: config.json は深いマージ済みだが型・必須チェックなし。
10. **data/*.json の世代管理なし**: 破損時の世代バックアップ自動復元は未実装（#42 open）。

### セキュリティ・認証（11-18)

11. **npm audit 65件残存**: 多くは transitive/breaking-change-only だが既知脆弱性が積存。
12. **apollo-server-express v3（EOL）**: GraphQL 経路が保守切れ依存に乗っている（#46 closed=不採用）。
13. **パスワードリセット導線なし**: forgot/reset フローが main に存在しない（#49 open）。
14. **Webhook に HMAC 署名・リトライなし**: 受信側が送信者を検証できず配送も best-effort（#32/#33 open）。
15. **JWT シークレットのローテーション手段なし**: 鍵更新で全セッション即失効しかない。
16. **.env 平文管理**: 秘密情報がファイルのみ。KMS/secret store 連携なし。
17. **ログへの PII 混入リスク**: email 等の個人情報がログに残り得る経路が残る。
18. **2FA 強制なし**: TOTP は master-auth 昇格のみで通常ユーザーには任意/不在。

### 製品機能（19-30)

19. **マーケットプレイスの核機能が休眠**: オークション談合検知（#10）・カーボン対応（#11）・スポットティア（#13）・標準スコア（#16）等は PR 積みで未マージ。
20. **プロバイダ heartbeat 不在**: 断線出品が stale 化しない（#31 open）。
21. **ベンチマーク乖離スコア不在**: 申告スペックと実測の差異スコア（#21 open）。
22. **ステークスラッシング/アンボンディング不在**: 担保経済学が未配線（#19/#22 open）。
23. **実消費メータリング課金なし**: 時間枠課金のみ（#20 open）。
24. **部分決済リトライキュー不在**（#18 open）。
25. **GPU 障害時のエスクロー連動が不完全**: 自動対応での返金/解放経路が弱い（#34 open）。
26. **Electron デスクトップはスタブ級**: シェルは実装済みだが横断機能は未実装（checklist 修正 #188 closed=不採用）。
27. **SPA フロントが単一静的ファイル構成**: フレームワーク不在で拡張困難。
28. **管理ダッシュボードは API の薄い SPA**: 認証・エラー処理が簡易。
29. **通知チャネルの偏り**: Slack/LINE メイン。LINE Notify 廃止対応済みだが汎用 webhook 成熟度が低い。
30. **OpenAPI は生成型だが契約テストが浅い**: 幻影パスは解消済み（#36 open）もスキーマ精度は限定的。

### テスト・CI（31-38）

31. **`--forceExit` が残置**: ハンドルリークを静黙化するフラグが残る（削除 PR #267 closed=不採用）。今後のリークが可視化されない。
32. **蓄積タイマーのログ肥大化**: unref 済みで終了は阻害しないが、全量 jest 実行中は発火し続け audit/error ログが肥大化する設計が残る。
33. **e2e（playwright）が CI 非接続**: testMatch から除外され常時赤が1件残る（#265 closed）。
34. **CI のパスフィルタで coverage ジョブが抜ける**: docs-only 変更は test ジョブ自体がスキップ（仕様だがゲートとしては弱い）。
35. **CI ランナー待ちの長時間滞留**: build-test がキュー待ちで数日 pending になる（環境側の制約）。
36. **実 LND 経路のテストなし**: MockLnAdapter のみで本番 Lightning 経路は未検証。
37. **金額計算のプロパティテストなし**: satoshi 整数演算の境界は値例テストのみ。
38. **テスト数と実態の乖離が繰り返し発生**: ドキュメントの陳腐化が再発しうる構造（集計を自動化していない）。

### アーキテクチャ・運用（39-50）

39. **単一プロセス前提**: レート制限・キャッシュ・タイマーがすべてプロセス内。水平スケール不可。
40. **複数デーモンループの乱立**: invoice-poller/service-monitor/gpu-monitor/sla-tracker 等が個別 setInterval で散在。
41. **休眠モジュールの保有コスト**: 未配線コード（p2p、各種 §機能 PR）がレビュー・保守負荷を生む。
42. **管理パススルー二重経路**: 非推奨 admin ルートが残り API 面が冗長。
43. **同期 fs 呼び出しの残存**: `readFileSync`/`writeFileSync`/`appendFileSync` がホットパス近辺に残る。
44. **エラーハンドリングの非一貫**: APIError 規約と生 throw が混在する箇所が残る。
45. **構造化ログの不統一**: winston ロガーと console 出力が混在。
46. **docker-compose/k8s は参考実装寄り**: 実装済みだが本番検証の形跡なし。
47. **依存の遅延 require パターンが散在**: optional dep 対策として合理的だが不統一。
48. **マルチリージョン/HA 設計なし**: 単一インスタンス前提で障害時の切替えなし。
49. **PR バックログ巨大**: #10-#52 の §機能バッチが数十件滞留しマージ判断がボトルネック化。
50. **監視の外側が弱い**: 自前メトリクス+通知はあるが、外形監視・合成監視は環境変数任意で標準では未接続。

## 第一原理監査（イーロン・マスク思考法）

製品の原子機能は「**レンターと GPU を価格でマッチし、検証済み成果に対してのみ資金を移す**」。
この3動詞（match/hold/settle）以外は全て機械である。第一原理からの問い:

1. **「DB」を本当に Postgres にすべきか?** — 現在のスケール（JSON で数百万行未満）では、Postgres 移行は「不整合リスクの追加」より「整合性不変条件の強化」（CAS・statゲート・atomicWrite）の方が ROI が高い。**結論: 移行ではなく不変条件の監査強化**。
2. **休眠モジュールは削除すべきか?** — 削除 PR は不採用が続いた。コード資産として残す判断はユーザーのもの。**結論: 削除せず「配線しない前提の安全性」を維持**（既に実施済み）。
3. **エスクローの本質的リスクは何か?** — 「資金が永久ロックされる」「二重に課金される」「未検証で解放される」の3つ。いずれも CAS+期限解放+HMAC 抽出で既に対策済み。**残る最悪ケースは複数ファイル更新の途中クラッシュ**（短所4）。
4. **CI が遅い本当の理由は?** — テスト自体は 30s 台。遅いのは**ランナー割当**であってコードではない。第一原理的には「テストを速くする」ではなく「キュー滞留時に合否を早期知る」が本質。
5. **監視は足りているか?** — 内部メトリクスは充実。欠けるのは「ユーザーから見える外形」: 外形監視の自動化とアラートの行動可能性。

## ソクラテス問答（仮定の検証）

| 仮定 | 反問 | 判定 |
|---|---|---|
| 「テストは速いはず」 | 実測は? | 全量 33.5s で緑。遅いのは実行ではなくキュー |
| 「--forceExit は必要悪」 | 無しで終了するか? | 自然終了を実測確認。ただし削除 PR は不採用（#267） — マスク継続を選択したと解釈すべきか? |
| 「JSON DB は遅い」 | stat ゲート後の実測は? | 静寂時はファイル未読で O(1)。ボトルネックは書込み側 |
| 「エスクローは安全」 | 複数ファイル更新の途中クラッシュは? | **非原子 = 残る最悪ケース**（短所4） |
| 「監視は網羅的」 | 外部から見た可用性は? | 内部 RED はあるが外形監視は任意 env のみ |
| 「休眠コードは無害」 | require 時の副作用・依存解決は? | 遅延 require 化で多く無害化済み。残存は限定的 |
| 「GraphQL は REST と等価」 | 認可境界のドリフトは? | テストで固定済みだが構造的に二重保守 |
| 「バックアップがあれば安全」 | 復元の正当性を検証するか? | 検証なし。破損バックアップの復元は未対策 |

## 改善点一覧（優先度付き・マージ可能性考慮）

### P0（正確性・資金安全性）

- **i1**: order+payment+escrow の複数ファイル更新に補償トランザクション or WAL 風ジャーナルを検討（現状の最大リスク。ただし大掛かり — まず整合性チェックスクリプトで不整合を検知する方が現実的）。
- **i2**: 整合性自己検査スクリプトの追加（`scripts/verify-data-consistency.js` 風。order↔payment↔escrow の参照整合を読み取り専用で検査。実行時副作用なしでマージ可能）。→ **対応済み**（#268 — 80+種の検査へ拡張中）。
- **i3**: POST /orders への冪等性キー (#26 open の内容。PR 済みのため再提出不可 — ユーザー判断待ち)。

### P1（信頼性）

- **i4**: `--forceExit` の扱いを文書化のまま据置（#267 で不採用と判断されたため、再提案はしない）。
- **i5**: jest 実行中の蓄積タイマーによる audit/error ログ肥大化の抑制（stopMonitor 徹底 or テスト環境での monitorServices 早期 return — 既に unref 済みで優先度は低下）。
- **i6**: バックアップ復元時の整合性検証（JSON パース + 必須キー存在チェック）。→ **対応済み**（#268 — 復元前検証）。
- **i7**: 同期 fs 呼出のホットパス残存箇所の棚卸（perf 影響の低い順に async 化）。→ **一部対応**（#268 — notification-settings を stat 指紋キャッシュ化。残存は低頻度のため棚卸のみ）。

### P2（観測性・運用）

- **i8**: テスト数の自動集計（jest `--listTests | wc -l` を CI artifact 化し、docs の手動記述を廃止）。→ **対応済み**（#268/#269 — `scripts/report-test-counts.js` で実測と docs 記載の drift 検出）。
- **i9**: 外形監視の標準化（UPTIME_* env が任意のまま — .env.example への推奨設定コメント追加）。→ **対応済み**（#268 — MONITOR_TARGETS コメントを実態へ修正）。
- **i10**: デーモンループの一元管理（registry パターンで stopAll を提供 — ただし runtime 配線は不採用傾向のため設計検討のみ）。→ **設計案+部分実装**（#268 — 付録の設計案 + backup-scheduler の stop 追加）。

### P3（機能面・open PR 依存）

- **i11-i20**: #10-#52 の §機能バッチはユーザー判断待ち。再送不可。改善点として列挙のみ（エスクロー清掃・heartbeat・webhook 署名・メータリング等）。

### P4（長期）

- **i21**: Postgres 移行の判断基準文書化（JSON の限界条件を明示 — 「何时移行するか」の定量化）。→ **対応済み**（#268 — 付録へ5条件+留保条件で定量化）。
- **i22**: npm audit の週次レポート整備（既に audit-notifier はあるが breaking-only が積存する現状の可視化）。→ **対応済み**（#268 — `scripts/report-audit-backlog.js` で3分類の積存可視化）。

## 今回の実施

本監査の P0/i2 相当として、**JSON リポジトリの整合性を読み取り専用で検査するスクリプト**
（`scripts/verify-data-consistency.js`、`npm run verify-data`）を実装した: order↔payment↔escrow
の参照切れ・終端 order の未清算 escrow（PENDING/HELD/DISPUTED = 資金保持中）・SETTLED↔非completed・
同一 order の二重 open escrow・閉じた escrow×進行中 order・gpu/user 横断参照（warn）・重複 id・
パース破損を報告（副作用なし、不整合で exit 1）。escrows.json は `state` フィールド
（PENDING/HELD/SETTLED/CANCELED/DISPUTED、escrow-state-machine.js 準拠）で検査。
併せて本監査を `docs/` に恒久的に配置し、今後の改善選定の参照点とする。

## 付録: JSON→Postgres 移行の定量的判断基準（i21）

監査のソクラテス問答（「JSON で本当に足りるか?」→「何が限界を生むか?」）から、移行は
早すぎても遅すぎても失敗する。以下の**いずれかが満たされた時点**が移行判断の閾値:

1. **書き込み競合がプロセス境界を越える**: 現行のロックはプロセス内 `withLock` のみ。
   API を2プロセス以上に水平展開（k8s replicas≥2、cluster fork、ロードバランサ背後の
   複数ノード）した時点で、atomicWrite の rename はファイル単位の原子的置換を保証するが
   **読み→改変→書きの read-modify-write は別プロセスの中間更新を巻き込む**（lost update）。
   複数プロセス化 = 即移行判断。
2. **最大コレクションが ~10万レコード超**: getAll+フィルタは全量パースのため、
   レコード数に線形な読み出しコスト。orders/payments が 10^5 級になると
   リクエスト処理系のレイテンシが支配的になる（stat ゲートキャッシュで
   緩和されるが、書き込み頻度が高いと指紋が変わりキャッシュは無効化される）。
3. **書き込み頻度が読み取り頻度を超える**: キャッシュの前提は「書き込みは疎」。
   メータリング/uptime のような高頻度書き込みが来ると stat 指紋が常に変わり
   キャッシュが効かなくなる（その時点で全量パース × 高頻度の二重コスト）。
4. **トランザクション必須の複数コレクション更新**: order+payment+escrow の
   一括整合性がビジネス的に必須になった時点（現状は i2 検査+手動修復で運用する前提。
   「不整合が許容できない」が SLI になったら JSON では不変条件を守れない）。
5. **クエリ多様化**: 日付範囲・部分一致・結合のようなアドホック検索が必要になった
   時点。JSON は「id 主キー + 手書きフィルタ」専用設計であり、それ以外の検索は
   全部全量スキャン＋アプリ側フィルタになる。

**反対に「まだ移行しない」条件**: 単一プロセス・各コレクション < 数万行・
書き込み疎・不整合は検査＋手動修復で許容、の全てが真なら JSON で運用継続が正当。
（短所 W36「二重パラダイム」は移行途中の過渡状態を長引かせないための理由でもある —
移行するなら Prisma 経路を完成させるか JSON を完成させるか、両方を未完のままにしない。）

## 付録: デーモンループ一元管理の設計案（i10）

監査のソクラテス問答（「テスト中にタイマーが暴発するのはなぜか?」→「各ループが
独自に抑止規約を持ち、stop の呼び方が統一されていない」）。実装は runtime 配線の
ため不採用傾向だが、採用判断が変わった場合の設計を固定しておく。

### 常駐ループ棚卸（server.js 起動順）

| デーモン | 起動 | 停止関数 | 周期/env | テスト抑止 |
|---|---|---|---|---|
| metricsInterval | server.js:94 | clearInterval（ハンドルのみ） | 10s | NODE_ENV=test で未作成 |
| service-monitor | server.js:123 `startMonitor()` | `stopMonitor()` | `SERVICE_MONITOR_INTERVAL_MS` | server.js 側で抑止 |
| invoice-poller | server.js:137 `start(lightning)` | `stop()` | 15s | 内部抑止 |
| sla-tracker | server.js:145 `startSLATracker()` | `stopSLATracker()` | 1min | 内部抑止 |
| backup-scheduler | server.js:153 `startBackupScheduler()` | **なし**（timer ハンドルを返すのみ） | `BACKUP_INTERVAL_HOURS` opt-in | 内部抑止 |
| gpu-auto-heal | server.js:164 `startGpuAutoHeal()` | クラス `stop()` | `GPU_AUTO_HEAL_INTERVAL_MS` opt-in | 内部抑止 |

### 指摘された不一致

1. **stop API の名前がバラバラ**（stopMonitor/stop/stopSLATracker/欠落）。一括停止が書けない。
2. **backup-scheduler は stop を export しない** — ハンドル戻り値のみ。プロセス終了時の確定的後始末がない。
3. **テスト抑止の責任場所が二層**（server.js 側で抑止するもの・内部で抑止するもの）が混在し、新規デーモン追加時にどちらに従うか不明瞭 — jest 環境で「片方だけ書き忘れ」が起きやすい。

### 設計案（将来実装する場合）

```js
// src/core/daemon-registry.js（構想 — 実装しない）
const daemons = new Map(); // name -> { start, stop, running }
function registerDaemon(name, { start, stop }) { daemons.set(name, { start, stop, running: false }); }
function startDaemons() { for (const d of daemons.values()) if (!d.running) { d.start(); d.running = true; } }
function stopAllDaemons() { for (const d of daemons.values()) if (d.running) { try { d.stop(); } finally { d.running = false; } } }
```

- server.js は `registerDaemon` するだけで抑止規約を一箇所に集約（NODE_ENV==='test' なら startDaemons が no-op）。
- 各デーモンは `stop` 必須として normalize（backup-scheduler に `stopBackupScheduler` を足す最小変更から始める）。
- テストから `stopAllDaemons()` を呼べば「次の tick が残存」問題を確定的に排除。
- ただし現行の個別抑止も機能しているため、現時点は設計固定に留め、実装の P 優先度は低い。
