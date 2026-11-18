#!/bin/bash
# 一键把「开机自启 + 巡检自愈」注册到 launchd。
#
# ── 现在的分工
#   容器自己负责：进程崩了自动重启（`restart: unless-stopped`）
#   Docker 重启后：Docker 引擎会把它们拉回来
#   **launchd 只负责一件事**：登录后把整套 compose 起起来，并每 5 分钟幂等地巡检一次。
#
#   这样安排的原因：Docker Desktop 是 GUI 应用，登录后要几十秒才就绪；
#   而「网关没跑」这类故障是**静默**的（拍单不发货、平台端却一切正常），
#   必须有个不问缘由、定时去拉一把的东西兜底。
#
# ── 为什么不再用三个 agent
#   旧方案（com.fmkj.xgj-tunnel / wechat-tunnel / wechat-serve）各自拉起一个本机进程。
#   隧道与服务已经全部收进 docker compose，三个 agent 由**一个** com.fmkj.stack 取代。
#   本脚本会自动把旧的三个卸掉。
#
# ⚠️ 必须在**你自己的终端**里跑 —— 本项目的沙箱不允许注册 launchd
#    （实测 `Bootstrap failed: 5: Input/output error`）。
#
# 用法：
#   bash scripts/install-agents.sh            # 安装并启动
#   bash scripts/install-agents.sh --status   # 只看状态（含两条公网链路实测）
#   bash scripts/install-agents.sh --remove   # 卸下（停止并取消自启）
set -uo pipefail

UID_=$(id -u)
AGENTS_DIR="$HOME/Library/LaunchAgents"
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.fmkj.stack"
WRAPPER="$HOME/bin/fmkj-stack-up.sh"
PLIST="$AGENTS_DIR/$LABEL.plist"
LEGACY=(com.fmkj.xgj-tunnel com.fmkj.wechat-tunnel com.fmkj.wechat-serve)

MODE="${1:-install}"

hr() { printf '%s\n' "────────────────────────────────────────"; }

# 公网链路实测：这一项才是真正的结论（端口在监听 ≠ 通）
# ⚠️ 微信那条故意**不带签名**去打 —— 期望被拒 403，403 恰好证明请求打到了我们自己的服务。
#    502 / 000 才是隧道断了。
CHECKS=(
  "闲管家 · 拍单回调|https://xgj.fmkj.top/goofish/ping|405|网关正常应答"
  "微信   · 关键词回复|https://xgj.fmkj.top/wechat|403|已打到本机服务（验签被拒）"
)

status() {
  echo "── launchd 里的 fmkj 条目 ──"
  if launchctl list 2>/dev/null | grep -qE "fmkj"; then
    launchctl list 2>/dev/null | grep -E "fmkj" | awk '{printf "  %-8s %-6s %s\n", $1, $2, $3}'
  else
    echo "  ⚠️ 一个都没有 —— 重启电脑后所有服务都不会自动起来"
  fi

  echo
  echo "── 容器状态 ──"
  (cd "$PROJ" && docker compose ps 2>/dev/null | sed 's/^/  /') || echo "  （docker 不可用）"

  echo
  echo "── 公网链路实测（真正的结论看这里）──"
  for row in "${CHECKS[@]}"; do
    IFS='|' read -r name url want note <<<"$row"
    got=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)
    if [ "$got" = "$want" ]; then
      # ⚠️ 变量一律写 ${}：bash 3.2 下 `$got（` 会把中文的字节吞进变量名 → set -u 报 unbound
      echo "  ✔ ${name} → HTTP ${got}（${note}）"
    else
      echo "  ✘ ${name} → HTTP ${got}（期望 ${want}）${note}"
    fi
  done

  echo
  echo "── 最近日志 ──"
  for f in "$HOME/Library/Logs/fmkj-stack.log"; do
    [ -f "$f" ] && { echo "  [$f]"; tail -6 "$f" | sed 's/^/    /'; }
  done
  true
}

install() {
  mkdir -p "$AGENTS_DIR" "$HOME/bin" "$HOME/Library/Logs"

  # ── 1. 纯 ASCII 路径的包装脚本
  # plist 里放非 ASCII 路径会 load 失败，所以仓库路径（含中文）藏在这里。
  cat > "$WRAPPER" <<EOF
#!/bin/sh
# 由 scripts/install-agents.sh 生成，不要手改（改仓库里的 scripts/docker-stack-up.sh）。
exec /bin/bash "$PROJ/scripts/docker-stack-up.sh"
EOF
  chmod +x "$WRAPPER"
  echo "✔ 包装脚本：$WRAPPER"

  # ── 2. plist
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${WRAPPER}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- 每 5 分钟幂等地 up 一次：「静默失效」是这类链路最大的敌人，
       与其等人想起来去看，不如让机器定时去拉一把。up 对已在跑的服务无副作用。 -->
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/fmkj-stack.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/fmkj-stack.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
EOF
  echo "✔ plist：$PLIST"

  # ── 3. 卸掉旧方案（三个独立 agent）
  for old in "${LEGACY[@]}"; do
    if [ -f "$AGENTS_DIR/$old.plist" ]; then
      launchctl bootout "gui/$UID_/$old" 2>/dev/null && echo "✔ 已卸下旧 agent：$old" \
        || echo "  （$old 本来就没加载）"
      mv "$AGENTS_DIR/$old.plist" "$AGENTS_DIR/$old.plist.disabled-20261015" 2>/dev/null \
        && echo "  → 旧 plist 已改名保留：$old.plist.disabled-20261015"
    fi
  done

  # ── 4. 加载
  echo "── 加载 $LABEL"
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true   # 幂等：先卸再装
  if launchctl bootstrap "gui/$UID_" "$PLIST" 2>&1; then
    echo "   ✔ 已加载"
  else
    echo "   ✘ 加载失败（见上）"
    exit 1
  fi

  echo
  echo "等 12 秒让容器起来…"
  sleep 12
  hr
  status
  hr
  echo "完成。日志：~/Library/Logs/fmkj-stack.log"
  echo "⚠️ 若上面「公网链路实测」有 ✘：先跑 npm run watch:tunnel -- --heal，"
  echo "   仍不行再看 docs/迁移-搬到别的机器.md 的排查一节。"
}

remove() {
  echo "── 卸下 $LABEL"
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null && echo "   ✔ 已停止并取消自启" \
    || echo "   （本来就未加载）"
  for old in "${LEGACY[@]}"; do
    launchctl bootout "gui/$UID_/$old" 2>/dev/null && echo "   ✔ 顺带卸下 $old" || true
  done
  echo
  echo "提示：plist 与 ~/bin 下的包装脚本都保留，随时可重新安装。"
  echo "      容器本身仍在跑 —— 要停服务请用 docker compose down。"
}

case "$MODE" in
  --status) status ;;
  --remove) remove ;;
  install|*) install ;;
esac
