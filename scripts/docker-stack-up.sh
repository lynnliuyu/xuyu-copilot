#!/bin/bash
# 把整套常驻服务拉起来（由 launchd 调用，也可手工跑）。
#
# ── 为什么要包一层，而不是让 launchd 直接跑 docker compose
#   ① plist 里不能出现非 ASCII 路径 —— 实测会 `Bootstrap failed: 5: Input/output error`，
#      而本项目的仓库路径含中文。所以 plist 只引用 ~/bin 下的纯 ASCII 包装脚本。
#   ② Docker Desktop 是**GUI 应用**：登录后要几十秒才把守护进程拉起来。
#      launchd 的 RunAtLoad 往往先于它就绪，直接 compose 会报
#      「Cannot connect to the Docker daemon」然后白白失败一次。
#      所以这里先等守护进程，等到再 up。
#   ③ `docker compose up -d` 是**幂等**的：已经在跑的服务不会被重启。
#      因此这个脚本可以安全地反复执行 —— 它同时兼任「巡检自愈」。
set -uo pipefail

PROJ="/Users/noonebook/WorkBuddy/百度网盘mcp"
cd "$PROJ" || { echo "找不到项目目录：$PROJ"; exit 1; }

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# ── 1. 等 Docker 守护进程就绪（最多 5 分钟）
ready=0
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  [ "$i" = 1 ] && log "等待 Docker 守护进程就绪…"
  sleep 5
done
if [ "$ready" != "1" ]; then
  log "❌ 等了 5 分钟 Docker 仍未就绪 —— 整套服务都没起来。"
  log "   检查：Docker Desktop 是否设了「登录时启动」；或手点一下 Docker Desktop。"
  exit 1
fi

# ── 2. 幂等拉起（已跑的不会动）
docker compose up -d
rc=$?

# ── 3. 把结果写清楚：launchd 的日志是唯一的事后线索
log "docker compose up -d 退出码 ${rc}"
docker compose ps 2>/dev/null | sed 's/^/    /'

# ── 4. 公网链路实测（真正的结论看这里，不是看端口在不在听）
#    ⚠️ 变量一律写 ${}：bash 3.2 下 `$got（` 会把中文的字节吞进变量名。
#    判据：/goofish/ping 期望 405（网关正常应答）；/wechat 无签名期望 403（打到了本服务）。
check() {
  local name="$1" url="$2" want="$3"
  local got
  got=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)
  if [ "$got" = "$want" ]; then
    log "✔ ${name} → HTTP ${got}"
  else
    log "✘ ${name} → HTTP ${got}（期望 ${want}）—— 见 docs/迁移-搬到别的机器.md 的排查一节"
  fi
}
if [ "${SKIP_PROBE:-0}" != "1" ]; then
  check "闲管家回调" "https://xgj.fmkj.top/goofish/ping" 405
  check "微信关键词" "https://xgj.fmkj.top/wechat" 403
fi

exit $rc
