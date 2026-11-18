#!/usr/bin/env bash
# 公众号文章：一条命令跑完「封面 → 转换 → 发布前检查」
#
# 用法：
#   bash scripts/mp.sh --all            # 全部文章
#   bash scripts/mp.sh maccy            # 单篇
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$HOME/.workbuddy/binaries/python/envs/default/bin/python"
[ -x "${PY}" ] || PY="python3"

TARGET="${1:---all}"

if [ "${TARGET}" = "--all" ]; then
  IDS=$(ls articles/*.md | xargs -n1 basename | sed 's/\.md$//')
else
  IDS="${TARGET}"
fi

echo "════════ ① 公众号封面 ════════"
for id in ${IDS}; do
  SPEC="assets/mp-covers/${id}.json"
  if [ -f "${SPEC}" ]; then
    echo "── ${id}"
    "${PY}" scripts/render-mp-cover.py "${SPEC}"
  else
    echo "── ${id}  跳过（没有 assets/mp-covers/${id}.json）"
  fi
done

echo
echo "════════ ② 转成公众号 HTML ════════"
if [ "${TARGET}" = "--all" ]; then
  node scripts/article-to-mp.mjs --all
else
  node scripts/article-to-mp.mjs "articles/${TARGET}.md"
fi

echo
echo "════════ ③ 发布前检查 ════════"
if [ "${TARGET}" = "--all" ]; then
  node scripts/verify-mp-article.mjs
else
  node scripts/verify-mp-article.mjs "${TARGET}"
fi

echo
echo "完成。逐篇打开 out/mp/<id>/preview.html → 点「复制正文」→ 粘进公众号编辑器。"
