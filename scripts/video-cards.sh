#!/usr/bin/env bash
# 只渲染卡片（改文案时用，不用重跑整条视频）
#
# 用法：npm run video:cards -- assets/video-specs/maccy.json
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC="${1:-}"
if [ -z "${SPEC}" ]; then
  echo "用法：npm run video:cards -- <spec.json>"
  exit 2
fi

ID="$(basename "${SPEC}" .json)"
CARDS="out/video-${ID}/cards"

PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
[ -x "${PY}" ] || PY="python3"

"${PY}" scripts/render-video-cards.py "${SPEC}" "${CARDS}"
echo
"${PY}" scripts/verify-video-cards.py "${CARDS}"
