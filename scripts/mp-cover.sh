#!/usr/bin/env bash
# 只出公众号封面（改标题时用，不用重跑转换）
#
# 用法：npm run mp:cover -- maccy      或   npm run mp:cover -- --all
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
[ -x "${PY}" ] || PY="python3"

TARGET="${1:---all}"
if [ "${TARGET}" = "--all" ]; then
  SPECS=$(ls assets/mp-covers/*.json)
else
  SPECS="assets/mp-covers/${TARGET}.json"
fi

for s in ${SPECS}; do
  [ -f "${s}" ] || { echo "找不到 ${s}"; continue; }
  echo "── $(basename "${s}" .json)"
  "${PY}" scripts/render-mp-cover.py "${s}"
  echo
done
