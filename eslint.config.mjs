// ESLint flat config（ESLint 9）
// このリポジトリは Node.js/CommonJS 主体（src/, scripts/, tests/）。
// `npm run lint` が eslint 未導入で常に失敗していたため、実運用で回る最小構成を用意。
// ルール方針: スタイル系は導入せず、バグ検出系（no-undef, no-unreachable, no-dupe-keys 等の
// eslint:recommended）のみ有効化。段階的強化の余地は今後の課題。
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'data/**',
      'playwright-report/**',
      'test-results/**',
      // ブラウザ/Electron 向けアセットは Node プロジェクトの lint 対象外
      'public/**',
      '**/*.min.js',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      // 既存コード内の eslint-disable コメントは意図的なものが混在するため
      // 未使用ディレクティブの報告は抑制（運用ノイズ防止）
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // 実害のほぼない既存パターンを大量に検出するものは warn に落とす
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      'no-async-promise-executor': 'warn',
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-fallthrough': 'warn',
      'no-case-declarations': 'warn',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-redeclare': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-misleading-character-class': 'warn',
      'require-yield': 'warn',
      'getter-return': 'warn',
      'no-self-assign': 'warn',
      'no-useless-catch': 'warn',
      'no-useless-assignment': 'warn',
      'no-empty-pattern': 'warn',
      'no-ex-assign': 'warn',
      'no-func-assign': 'warn',
      'no-import-assign': 'warn',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'warn',
      'no-loss-of-precision': 'warn',
      'no-nonoctal-decimal-escape': 'warn',
      'no-obj-calls': 'error',
      'no-regex-spaces': 'warn',
      'no-sparse-arrays': 'warn',
      'no-unexpected-multiline': 'warn',
      'no-with': 'error',
      'prefer-const': 'off',
      'no-var': 'off',
    },
  },
  {
    // Jest テストファイルは jest グローバルを許可
    files: ['tests/**/*.js', '**/*.test.js', '**/__tests__/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  {
    // Playwright e2e: page.evaluate 内でブラウザグローバルを参照する
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // src/web はブラウザ向け ESM（React JSX を含む）
    files: ['src/web/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
      },
    },
  },
];
