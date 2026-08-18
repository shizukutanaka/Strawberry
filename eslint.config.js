// eslint.config.js — ESLint v9 flat config。
//
// 方針: **実際のバグを捕まえるルールだけ**を有効にする。
// `npm run lint` は以前 eslint.config.js が無くて必ず失敗しており、品質ゲートとして
// 機能していなかった（`npm run setup` が prisma で失敗していたのと同じクラスの欠陥）。
// ここで整形ルール（インデント・クォート・セミコロン）まで入れると、既存 109 ファイルに
// 大量の指摘が出て「常に赤い lint」になり、また誰も見なくなる。壊れた品質ゲートを
// 別の壊れ方に置き換えても意味が無いので、未定義変数・未使用変数・到達不能コードなど
// **バグそのもの**に絞る。整形は必要になった時点で prettier 等を別途入れればよい。
const js = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      // 注意: ここに 'public/js/**' を書いてはいけない。flat config の
      // グローバル ignores は後段の `files` ブロックより強く、下のブラウザ用
      // 設定ごと無効化される（＝ SPA が一度も lint されない状態になる）。
      // ブラウザ向け ES module は下の 3 番目のブロックで個別に設定している。
      'openapi.json',
      'data/**',
      'logs/**',
    ],
  },
  {
    // Node.js（サーバ本体・スクリプト・テスト）
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        AbortController: 'readonly', fetch: 'readonly', structuredClone: 'readonly',
        SharedArrayBuffer: 'readonly', Atomics: 'readonly', Int32Array: 'readonly',
        // Jest
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 未使用変数は「書いたが使っていない＝意図と実装のズレ」の兆候。ただし catch の
      // 握り潰し（`catch (_) {}`）と、意図的に読み捨てる分割代入は許す。
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // 整形・好みの類は無効（上のコメント参照）
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    // Playwright の e2e。page.evaluate() の中身は**ブラウザ内で**実行されるため、
    // localStorage / location / document 等がソース上に現れる（Node の undefined ではない）。
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', getComputedStyle: 'readonly',
        navigator: 'readonly',
      },
    },
  },
  {
    // ブラウザ側 SPA（public/js）。ネイティブ ES module で走る別環境。
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', Node: 'readonly',
        alert: 'readonly', history: 'readonly', navigator: 'readonly',
        CustomEvent: 'readonly', Event: 'readonly', HTMLElement: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
