# Contributing to Strawberry P2P GPU Marketplace

Thank you for considering contributing to Strawberry! 🚀

## How to Contribute

- Fork this repository and create your branch from `main` (there is no `develop` branch).
- Make your changes (feature, fix, docs, etc.)
- Run `npm run lint` and `npm test` to ensure quality.
- If you add/update API, run `npm run openapi` to update OpenAPI docs.
- Push your branch and open a Pull Request (PR) with a clear description.
- For bug reports and feature requests, use GitHub Issues.

## Code Quality & CI

GitHub Actions workflows that run on PRs (all target `main`; a `develop` branch does not exist):

- `ci.yml` (`build-test`): `npm run lint` (non-blocking, `|| true`), `npm test`, build check
- `test-coverage-check.yml` (`test`): coverage gate — fails if line coverage drops below 70 (PRs touching `src/**`, `tests/**`, or `package.json`)
- `api-openapi-autogen.yml`: regenerates the OpenAPI spec when `src/utils/validator.js`, `src/api/openapi-generator.js`, or `package.json` changes
- `optimize-images.yml`: optimizes images on changes under `public/images/`
- `ci-cd.yml`: runs on pushes to `main` only (its Deploy step is currently an `echo` stub — no real deploy happens)

- Please do not commit `.env`, `data/`, or other ignored files
- Major changes may require review by maintainers

## Language/Docs

- PR/Issue/Docs in Japanese or English are both welcome!
- README and key docs are bilingual (日本語/English)

## Community

- Respectful, inclusive communication is required
- Commercial/academic/OSS users all welcome

---

# Strawberry P2P GPU Marketplace コントリビュートガイド

## 貢献方法

- このリポジトリをForkし、`main`からブランチを作成（`develop`ブランチは存在しません）
- 機能追加・修正・ドキュメント更新など自由にどうぞ
- `npm run lint`・`npm test`で品質確認
- API追加/修正時は`npm run openapi`でAPI仕様も更新
- プルリクエスト（PR）には内容説明を明記
- バグ報告・要望はGitHub Issueで受付

## コード品質・CI

PR で実行される GitHub Actions（対象は `main` のみ。`develop` ブランチは存在しません）:

- `ci.yml`（`build-test`）: `npm run lint`（ノンブロッキング）・`npm test`・ビルド確認
- `test-coverage-check.yml`（`test`）: カバレッジ閾値 70% ゲート（`src/**`・`tests/**`・`package.json` 変更の PR）
- `api-openapi-autogen.yml`: `src/utils/validator.js`・`src/api/openapi-generator.js`・`package.json` 変更時に OpenAPI 仕様を再生成
- `optimize-images.yml`: `public/images/` 変更時に画像最適化
- `ci-cd.yml`: `main` への push のみで実行（Deploy ステップは `echo` スタブであり実デプロイは行われません）

- `.env`や`data/`等はコミット禁止
- 重要な変更はメンテナーレビューあり

## 言語・ドキュメント

- 日本語・英語どちらも歓迎！
- README等はバイリンガル対応

## コミュニティ

- リスペクト・多様性重視
- 商用・学術・OSS利用いずれも歓迎
