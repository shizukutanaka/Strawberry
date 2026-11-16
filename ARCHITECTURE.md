# Strawberry アーキテクチャと現状（2026-06、2026-11-16 更新）

> **2026-11-16 の変更**: 所有者の方針により**金銭のやり取り機能を全て削除**した。
> 支払い（Lightning／銀行振込／BTC オンチェーン）、エスクロー、精算、運営利益アドレス、
> 収益・GMV 集計は存在しない。Strawberry は **GPU の貸し借り専用**であり、価格は
> GPU の掲載情報（表示・見積もり）としてのみ残る。Proof-of-Compute 検証と
> レピュテーションは貸し借りの品質担保として残置した。

このドキュメントは、リポジトリの**実態**を簡潔にまとめたもの。README や
`improvement_checklist2.md` の一部記述は実装より先行（aspirational）しているため、
本ファイルを一次情報として扱うこと。

## 実体は何か

- **本体は Node.js / Express の Web API サーバ**（`src/api/server.js`、`npm start`）。
- Electron デスクトップシェルは `public/electron.js`（メインプロセス）+
  `public/preload.js`（sandboxed preload）として実装済み（`npm run desktop` または
  `npx electron public/electron.js`）。`ipcMain` は監査ログチャネルのみ配線し、
  `STRAWBERRY_URL` 経由のリモート読み込みは https（ローカルのみ http 許可）に限定。
  配布パッケージング（electron-builder 等）は未配線。
- **`public/` は実際に動くフロントエンド**（2026-07 追加）。ビルド不要の静的SPA
  （素の HTML + CSS + ネイティブ ES modules、依存追加ゼロ）。`http://localhost:3000`
  で登録/ログイン・GPUマーケット閲覧・注文・稼働中セッション
  （ハートビート・停止）・レビュー・係争の申請/管理者裁定まで、実際に
  画面から一通り操作できる（以前は `public/index.html` が1行の空スタブで、ブラウザで
  見える画面が存在しなかった）。`#/`始まりのハッシュルーティング（`public/js/router.js`）。
  厳格CSP（`script-src 'self'` のみ、インラインスクリプト禁止）に対応済み。`/swagger.html`
  も同様の理由で CDN+インライン版から同一オリジンの自前ビューア（`public/js/docs.js`）に
  置換済み。GPU接続情報の実配信は native 経路で実装済み（2026-11-16）:
  割り当てごとに実在する HTTP セッションゲートウェイをホスト上に立て、
  endpoint とトークンを借り手へ受け渡す（注文詳細画面にも表示）。
  `STRAWBERRY_NATIVE_UPSTREAM_URL` が設定されていれば、そのホスト上の
  ローカル GPU サービスへ中継し、未設定なら生存確認のみ応答して計算パスは
  502 で正直に返す。解放でゲートウェイは閉じられる。別マシンのプロバイダ GPU
  への到達性は**提供者エージェント**（下記）で実装済み（2026-11-16）。
  残る制約: 実 GPU の利用統計は nvidia-smi 前提で、無い環境では null を返す。
- データ永続化は **`src/db/json/*` の JSON ファイルリポジトリが実際に稼働**している層。
  `prisma/` は依然として存在するが未配線・未使用。`src/core/database.js`
  （`pg`/`ioredis` — いずれもパッケージ未インストール）と `src/core/security.js`
  （`ioredis`/`rate-limiter-flexible` も未インストール）はどこからも import されず、
  かつ依存先パッケージ自体が存在しないため import すれば即座に失敗するコードだった。
  `knex`/`sqlite3` 依存とあわせて削除済み（2026-07）。当面 JSON のみが正。

## 起動パスとサービス

```
src/api/server.js
 ├─ middleware/security, middleware/logger, prom-client(/metrics)
 ├─ /master-auth      → routes/master-auth.js (Google OAuth は env 設定時のみ有効)
 ├─ /api/exchange-rate→ routes/exchange-rate.js
 ├─ WebSocket Upgrade: /api/v1/agent/connect → services/provider-agent-hub
 │    （提供者エージェントの外向き接続。JWT 認証。server 起動時のみ attach）
 └─ /api/v1 (routes/index.js)  ※ /system/info 以外は JWT 必須
      ├─ /gpus /orders /users /marketplace  → JSON リポジトリで動作
      └─ コアサービス: src/core/services.js 経由のガード付きシングルトン
           ├─ virtual-gpu-manager.js (dockerode/k8s)   … ロード可（要 Docker/k8s 実機）
           ├─ gpu-detector-extended.js                  … ロード可
           └─ p2p-network.js (libp2p)                   … 削除済み（libp2p 未導入で常時無効だったため）
```

### 提供者エージェント（別マシンの提供者 GPU への中継）

marketplace GPU は提供者のマシン上に実在するため、サーバと同一ホストの
ローカル上流では届かない。そのための経路が提供者エージェント:

```
借り手 → セッションゲートウェイ（サーバ上、割り当てごと）
       → 提供者ハブ（サーバ上、WebSocket レジストリ）
       → 提供者エージェント（提供者のマシン、agent/provider-agent.js）
       → 提供者のローカル GPU サービス（Ollama 等）
```

- **接続は提供者から外向き**（WebSocket、`GET /api/v1/agent/connect` の
  Upgrade）。NAT の内側の提供者にも届き、サーバ側から提供者へは接続しない。
  実装は Node 標準のみ（`src/services/ws-rfc6455.js` の最小 RFC 6455 実装 +
  `src/services/provider-agent-hub.js`）。新規依存は追加していない。
- **認証**: エージェント接続は提供者本人のアクセストークン（JWT）を
  既存 jwt-auth と同一手順で検証する。借り手のセッショントークンは
  ゲートウェイが先に検証し、トークンの無いリクエストはエージェントへ届かない。
- **認可の不変条件**: 中継の宛先は GPU レコードの `providerId` で決める。
  エージェントが受け取れるのは自分の GPU へのリクエストだけであり、
  他人のエージェントへ中継されることはない（テストで固定）。
- **SSRF 対策**: ゲートウェイは origin-form 以外の request-target を 400 で
  拒否し（ローカル経路と共通）、エージェントは起動時に指定した
  `STRAWBERRY_UPSTREAM_URL` の origin へしか中継しない（二重防御）。
- **経路の優先順位**: 提供者のエージェントが接続していればエージェント経路、
  無ければ `STRAWBERRY_NATIVE_UPSTREAM_URL` のローカル中継、どちらも無ければ
  理由つきの 502。接続状態は割り当ての `accessInfo.providerAgent` と
  ゲートウェイの `/health` に正直に出る。

正直な限界:

- **ストリーミングはしない**。トンネルは JSON+base64 のバッファリング方式で、
  リクエスト/レスポンスとも上限 15MB。Ollama 等のストリーミング応答も
  一括で返る（トークンの逐次表示はできない）。
- **再接続時のセッション扱い**: エージェントが切断されると、その間の
  ゲートウェイへの計算リクエストは 502 になる。セッション自体（ゲートウェイと
  トークン）は維持され、エージェントが再接続すれば同じセッションへ再び届く。
  接続中に切断されたリクエストは再送されない（借り手側のリトライが必要）。
- **サーバ再起動で接続は切れる**。エージェントは指数バックオフで自動再接続する。
- 実 GPU・実 Ollama での検証は未実施（スタブ上流での実走スモーク
  `scripts/smoke-provider-agent.js` とテストで一往復を固定している）。

### コアサービスのガード方針（重要）

`virtual-gpu-manager` はリポジトリ直下に置かれた
大型モジュールで、ネイティブ依存（dockerode）を持つ。これをモジュール読込時に `new` していたため、
従来は Web API 全体が起動不能だった。

現在は `src/core/services.js` が全て **try/catch で安全に読み込み、失敗時は `null`**
（無効化モード）にフォールバックする。各サービスを使うエンドポイントは `requireService()`
で **503** を返す。これにより JSON データ層で動く API 本体は常に起動できる。

コードレビュー後の修正で、`virtual-gpu-manager` / `gpu-detector-extended`
の読込阻害バグ（誤った `../utils/logger` 相対パス、
`child_process.promises`・`fs.promises` 誤用）を解消し、**ロード・インスタンス化が可能**になった
（実機能は Docker/k8s 実機が必要。`virtual-gpu-manager` のコマンド実行は
識別子サニタイズ済み）。`p2p-network` は libp2p 未導入で `require()` 自体が
失敗し常時無効だったため、後に削除した。`lightning-service` は金銭機能の
全廃（2026-11-16）に伴い削除した。

これらインフラ系依存は `package.json` の `optionalDependencies`（libp2p 一式は未宣言）に置く。

## このブランチで修正した主な内容

- **起動・インストール可能化**: 未宣言依存を `package.json` に追加、`main` を実在エントリへ修正、
  `server.js` の起動クラッシュ（`masterAuth.router` 参照ミス・require の TDZ）と
  各ルートの未 import（`Joi` / `allowOwnerOrAdmin` / `asyncHandler`）・二重宣言（`Joi`）、
  `security.js` の未定義 export（`apiKeyAuth`）、`lru-cache` v10 API、`child_process.promises`、
  `validator.js` の二重 `const Joi` などを修正。`server.js` は直接実行時のみ listen。
- **重大セキュリティ修正**:
  - ハードコード秘密鍵フォールバック廃止 → `config.requireSecret()` で本番 fail-fast / 開発は一時鍵。
  - `virtual-gpu-manager` のシェル実行を識別子サニタイズでインジェクション対策。
  - `.env.example` に必須 env を明記。

## テスト状況（正直版）

`npm test`（Jest, `--forceExit`）は **218/221 スイート green**（1722/1726 テスト、2 スイート
＋3 テストが環境依存で skip、残る失敗 1 件は公開 URL の DNS 解決に依存する SSRF テストで
実行環境要因。2026-11-16 時点。提供者エージェントのテスト 2 スイートを含む）。当初あった aspirational な失敗群（未実装エンドポイント・旧スキーマ
参照）は逐ー是正済み。`--forceExit` が必要なのは起動時のサービス初期化タイマー類が
イベントループに残るためで、テストの成否とは無関係。

実行: `npm install` → `npm test`。サーバ起動確認: `npm start`（`http://localhost:3000` で
実際に動くマーケットプレイスUIが表示される。`/metrics` はPrometheusメトリクス、
`/swagger.html` はAPIドキュメント）。

## フォローアップ（未対応・推奨順）

1. P2P が必要になれば別実装として新規に切り出す（旧 `p2p-network` は削除済み）。残るサービスは実機(Docker/k8s)での結合検証。
2. データ層を一本化（当面 JSON 維持、将来 Prisma へ。未配線のまま残っていた `prisma/schema.prisma`
   は削除済みで、移行には未着手のスキーマ設計から必要）。
3. サービスの DI/シングルトン統一（`*-fixed.js` 孤立ファイルは削除済）。
4. ~~Electron の本実装 or 撤去判断~~ → **解決済み（2026-07）**: Electron 断片は削除し、
   代わりに `public/` の実フロントエンド（上記）を新規実装。デスクトップアプリが必要になれば
   このWeb版とは別に `ipcMain`/`ipcRenderer` から設計すること。
5. ~~既存テストの実装整合化~~ → **解決済み（2026-09）**: 全スイート green（上記）。
6. `.github/workflows/ci.yml` のデプロイ手順を Docker ビルド+`/health` スモークテストへ置換
   （2026-07、diff はコミット履歴に用意済みだが `workflows` 権限が無い環境からはプッシュ不可
   だったため未適用。`workflows` 権限を持つ人が手動適用する必要あり）。旧手順は存在しない
   `build/` への `netlify deploy` で、ステートフルな Express アプリには元々デプロイ先として
   不適切だった。

### 既知の重大ギャップ（要対応）

- **JSON 層のクロスプロセス lost-update**: `createJsonRepository` の書き込みは
  temp+rename で単一プロセス内は原子的だが、PM2 クラスタ等の複数ワーカーでは
  flock 相当のクロスプロセス排他がないため「両者 load → 別キー更新 → 後勝ち rename」で
  更新消失が起こりうる。マルチプロセス運用前に flock もしくは単一ライタープロセス化が必要。
  （単一プロセス運用では問題なし。`peerID`/`notification-settings` は
  プロセス内 `withLock` で直列化済み。）
