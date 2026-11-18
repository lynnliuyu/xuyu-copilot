#!/usr/bin/env bash
# 取出当前隧道的公网地址，并顺手做一次端到端连通性验证。
#
#   npm run tunnel:url
#
# 用途：把打印出的 https://xxx.trycloudflare.com 填进
#       闲管家 → 我的应用 → 货源授权信息 → 接口网关（填到域名部分，结尾不带 /goofish）
set -euo pipefail

cd "$(dirname "$0")/.."

URL="$(docker logs xgj-tunnel 2>&1 \
  | grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' \
  | tail -n 1 || true)"

if [[ -z "${URL}" ]]; then
  echo "❌ 还没拿到隧道地址。先看日志：" >&2
  echo "   docker compose logs --tail=50 cloudflared" >&2
  exit 1
fi

echo "公网地址: ${URL}"
echo "填到闲管家「接口网关」: ${URL}"
echo

echo -n "本地健康检查  : "
curl -s --max-time 8 "http://127.0.0.1:8787/__health" || echo "(失败)"
echo

echo -n "公网健康检查  : "
curl -s --max-time 15 "${URL}/__health" || echo "(失败：隧道可能还在建，等几秒重试)"
echo
