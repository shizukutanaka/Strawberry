#!/bin/bash
# ビルドスクリプト — クリーンな依存導入と生成物（OpenAPI 仕様）の再生成。
# このリポジトリの Node サーバにはコンパイル工程がないため、
# 「ビルド」が意味するのは npm ci と生成物の最新化まで。
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
npm run openapi-gen
