#!/bin/bash
# 本番起動前の preflight。server.js は NODE_ENV=production で
# requireSecret が未設定シークレットを fail-fast させるため、
# 起動前に必須環境変数の有無をここで検査する。
#
# 使い方:
#   ./scripts/setup-production.sh          # 検査 + 本番依存のみ導入
#   ./scripts/setup-production.sh --check  # 検査のみ（npm ci を実行しない）
set -euo pipefail
cd "$(dirname "$0")/.."

missing=()
for var in JWT_SECRET SESSION_SECRET ENCRYPTION_KEY; do
  # JWT_SECRET は 32 文字以上、その他は 16 文字以上が要求される（config.js requireSecret）。
  min=16
  [ "$var" = "JWT_SECRET" ] && min=32
  val="${!var:-}"
  if [ -z "$val" ] || [ "${#val}" -lt "$min" ]; then
    missing+=("$var(>=${min}文字)")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: 必須環境変数が未設定または不足です: ${missing[*]}" >&2
  echo "  .env に設定してください（.env.example 参照）。" >&2
  exit 1
fi
echo "preflight OK: 必須シークレットが設定されています"

if [ "${1:-}" = "--check" ]; then
  exit 0
fi

npm ci --omit=dev
echo "setup-production 完了（NODE_ENV=production で npm start を実行してください）"
