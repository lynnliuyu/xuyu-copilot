#!/usr/bin/env bash
# 一条命令跑完「图文转视频」全流程，并自动验收
#
# 用法：bash scripts/video.sh assets/video-specs/maccy.json
# 产物：out/video-<id>/  （cards/ + <id>-竖版.mp4 + 发布文案.md）
#
# 依赖：ffmpeg（隔离目录里的静态包）、Pillow（隔离 venv）、字体 .cache/fonts/NotoSansSC-VF.ttf
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC="${1:-}"
if [ -z "${SPEC}" ]; then
  echo "用法：bash scripts/video.sh <spec.json>"
  exit 2
fi
if [ ! -f "${SPEC}" ]; then
  echo "找不到规格文件：${SPEC}"
  exit 2
fi

ID="$(basename "${SPEC}" .json)"
OUT="out/video-${ID}"
CARDS="${OUT}/cards"
MP4="${OUT}/${ID}-竖版.mp4"

# 优先用隔离 venv 里的 python（Pillow 装在那儿）
PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
[ -x "${PY}" ] || PY="python3"

echo "════════ ① 渲染卡片 ════════"
"${PY}" scripts/render-video-cards.py "${SPEC}" "${CARDS}"

echo
echo "════════ ② 验收卡片排版 ════════"
"${PY}" scripts/verify-video-cards.py "${CARDS}"

echo
echo "════════ ③ 装配视频 ════════"
node scripts/make-video.mjs --spec "${SPEC}"

echo
echo "════════ ④ 抽帧回比 ════════"
"${PY}" scripts/verify-video-frames.py "${MP4}" "${CARDS}" "${SPEC}"

echo
echo "全部完成 → ${MP4}"
