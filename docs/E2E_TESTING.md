# E2E テスト（Playwright）

`tests/e2e/` は jest の supertest 系スイートがカバーしない層 —— 実ブラウザでの DOM 描画・CSP 強制・`public/js/*` のクライアント側ルーティング/状態管理 —— を、実サーバへ実 HTTP リクエストで検証する。設定は `playwright.config.js`。

## セットアップ

```bash
npm install                      # @playwright/test は devDependencies
npx playwright install chromium  # ブラウザ本体（初回のみ必要）
```

`PLAYWRIGHT_CHROMIUM_PATH` が設定されている場合はそのバイナリを使う（ダウンロード不要）。サンドックス内の `/opt/pw-browsers/chromium` が存在すれば自動でフォールバックする。

## 実行

```bash
npm run test:e2e
```

`webServer` が自動で `node src/api/server.js` をポート **3010**・`NODE_ENV=test` で起動する。

- `NODE_ENV=test`: 本番向けレートリミッター（`src/api/middleware/security.js` の apiLimiter）を迂回し、フル実行が 429 で止まらないようにする
- `PORT=3010`: 開発中の `npm start`（3000）との衝突回避
- ローカルで既に対象サーバが起動していれば再利用する（`reuseExistingServer`）。CI では常に新規起動

既存の任意サーバを対象にする場合:

```bash
E2E_BASE_URL=http://localhost:3000 npm run test:e2e   # webServer 起動をスキップ
```

## 注意事項

- **`data/*.json` を破壊的にリセットする。** `tests/e2e/globalSetup.js` が実行冒頭でユーザ/注文/GPU/エスクロー等を全て空に書き戻す（jest 版と同じ設計）。ローカルの開発用 `data/` に残したいデータがある場合は退避してから実行する。
- **`workers: 1`・`fullyParallel: false` は意図的。** ストレージが単一ライターの JSON ファイル層のため、スペック並列化は共有データ競合を起こす。
- 失敗時は `test-results/` に trace とスクリーンショットが残る（`trace: 'retain-on-failure'`）。`npx playwright show-trace test-results/<dir>/trace.zip` で時系列再生できる。
- 各 spec は `helpers.js` のタイムスタンプ付きユニーク ID でユーザ/リソースを作るため、リセットを挟まない反復実行でも一意性衝突しない。

## スペック一覧（9件）

| ファイル | describe ブロック |
|---|---|
| `auth.spec.js` | auth（登録・ログイン・セッション） |
| `auth-refresh.spec.js` | token refresh |
| `marketplace.spec.js` | marketplace |
| `gpu-detail-and-summaries.spec.js` | GPU detail page・provider earnings・order stats on the orders list |
| `order-lifecycle.spec.js` | order lifecycle |
| `admin-payments.spec.js` | admin payments |
| `admin.spec.js` | admin dashboard |
| `dispute.spec.js` | dispute |
| `accessibility.spec.js` | accessibility regression guards |
