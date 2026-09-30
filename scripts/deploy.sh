#!/bin/bash
# デプロイスクリプト
# このリポジトリにはデプロイパイプラインが未配線
# （ci-cd.yml の Deploy ジョブは echo スタブ。k8s/compose マニフェストは
#  環境固有の調整が前提）。
# 何もせず終了コード 0 で返ると CI/運用から「デプロイ成功」と誤認されるため、
# 明示的に失敗させてガイドを出す。
set -euo pipefail

echo "deploy.sh: デプロイ経路はこのリポジトリに未構成です。" >&2
echo "  運用可能な手順は docs/operations.md を参照してください。" >&2
exit 1
