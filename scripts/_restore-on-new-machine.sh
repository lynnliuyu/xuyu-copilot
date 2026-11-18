#!/bin/bash
# 在新电脑上从迁移包恢复工作副本。
#
# 用法：
#   bash scripts/_restore-on-new-machine.sh <解包后的迁移包目录>            # 预演，只打印计划
#   bash scripts/_restore-on-new-machine.sh <解包后的迁移包目录> --apply    # 真正执行
#   ... --apply --force-config    # 覆盖已有 ~/.ssh/config（默认不覆盖，只提示手工合并）
#
# 前提：当前目录是项目根（空目录也行，脚本会把代码解到这里）
#
# 它会做：解代码 → 放回 .env/台账/密钥/CLI 凭据 → 装依赖 → 打印下一步人工事项
# 它不会做：装 launchd、改各脚本里的绝对路径（这两件必须你自己确认）

set -uo pipefail

BUNDLE="${1:-}"
APPLY=0
FORCE_CONFIG=0
[ -z "$BUNDLE" ] && { echo "用法：bash scripts/_restore-on-new-machine.sh <迁移包目录> [--apply]"; exit 1; }
shift || true
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --force-config) FORCE_CONFIG=1 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done

BUNDLE="$(cd "$BUNDLE" 2>/dev/null && pwd)" || { echo "❌ 找不到迁移包目录：$1"; exit 1; }
TARGET="$(pwd)"
S="$BUNDLE/03-secrets"

echo "═══ 恢复计划 ═══"
echo "迁移包：$BUNDLE"
echo "目标目录：$TARGET"
echo "模式：$([ $APPLY -eq 1 ] && echo '✅ 执行' || echo '🔍 预演（加 --apply 才真做）')"
echo

# preflight
for f in 01-code.tar.gz 03-secrets; do
  [ -e "$BUNDLE/$f" ] || { echo "❌ 迁移包不完整，缺 $f"; exit 1; }
done
[ -s "$S/.env" ] || { echo "❌ 缺 03-secrets/.env（没有它网关跑不起来）"; exit 1; }

run() { # run <描述> <命令...>
  local d="$1"; shift
  printf '  %-46s' "$d"
  if [ $APPLY -eq 1 ]; then
    if "$@" >/dev/null 2>&1; then echo "✅"; else echo "❌"; FAILED=$((FAILED+1)); fi
  else
    echo "（将执行：$*）"
  fi
}
FAILED=0

echo "① 解出代码与草稿"
run "01-code.tar.gz → $TARGET" tar -xzf "$BUNDLE/01-code.tar.gz" -C "$TARGET"
if [ -e "$BUNDLE/01b-out-scripts.tar.gz" ]; then
  mkdir -p "$TARGET/out"
  run "01b-out-scripts.tar.gz → out/" tar -xzf "$BUNDLE/01b-out-scripts.tar.gz" -C "$TARGET/out"
fi

echo "② 放回密钥与运行时状态"
run ".env"                     cp -p "$S/.env" "$TARGET/.env"
[ -e "$S/.tokens.json" ] && run ".tokens.json" cp -p "$S/.tokens.json" "$TARGET/.tokens.json"
[ -e "$S/drafts/.listings.json" ] && run "drafts/.listings.json" cp -p "$S/drafts/.listings.json" "$TARGET/drafts/.listings.json"
[ -e "$S/drafts/.excluded.json" ] && run "drafts/.excluded.json" cp -p "$S/drafts/.excluded.json" "$TARGET/drafts/.excluded.json"
if [ -d "$S/out" ]; then
  for f in "$S/out"/*.json; do [ -e "$f" ] && run "out/$(basename "$f")" cp -p "$f" "$TARGET/out/"; done
fi

echo "③ SSH（连生产机 134）"
mkdir -p "$HOME/.ssh"
[ $APPLY -eq 1 ] && chmod 700 "$HOME/.ssh"
[ -e "$S/ssh/xgj-134_ed25519" ] && {
  run "xgj-134_ed25519"          cp -p "$S/ssh/xgj-134_ed25519" "$HOME/.ssh/xgj-134_ed25519"
  [ $APPLY -eq 1 ] && chmod 600 "$HOME/.ssh/xgj-134_ed25519"
  [ -e "$S/ssh/xgj-134_ed25519.pub" ] && run "xgj-134_ed25519.pub" cp -p "$S/ssh/xgj-134_ed25519.pub" "$HOME/.ssh/"
}
if [ -e "$S/ssh/config" ]; then
  if [ -e "$HOME/.ssh/config" ] && [ $FORCE_CONFIG -eq 0 ]; then
    echo "  ⚠ ~/.ssh/config 已存在，不覆盖 → 请手工合并下面这段（或加 --force-config 强制覆盖）："
    echo "     ---- 追加到 ~/.ssh/config ----"
    sed -n '/Host xgj134/,/^$/p' "$S/ssh/config" | sed 's/^/     /'
    echo "     -----------------------------"
  else
    run "~/.ssh/config"          cp -p "$S/ssh/config" "$HOME/.ssh/config"
  fi
fi

echo "④ 中继机私钥（.env 里的 MEDIA_SSH_KEY / TUNNEL_SSH_KEY）"
# ⚠️ 这两个 pem 曾经漏收过：包看着完整，新机上 `npm run media:netdisk` 直接报找不到私钥。
if [ -d "$S/keys" ]; then
  for f in "$S"/keys/*.pem; do
    [ -f "$f" ] || continue
    run "~/.ssh/$(basename "$f")" cp -p "$f" "$HOME/.ssh/$(basename "$f")"
    [ $APPLY -eq 1 ] && chmod 600 "$HOME/.ssh/$(basename "$f")"
  done
  # 把 .env 里失效的旧绝对路径改成本机路径
  if [ $APPLY -eq 1 ]; then
    while IFS= read -r key; do
      name="$(basename "$key")"
      [ -f "$HOME/.ssh/$name" ] || continue
      # ⚠️ 定界符不能用 |：模式里本身有 (MEDIA|TUNNEL)，BSD sed 会把 | 当分隔符 → 「parentheses not balanced」
      sed -i.bak -E "s#^((MEDIA|TUNNEL)_SSH_KEY)=.*#\1=$HOME/.ssh/$name#" "$TARGET/.env"
      echo "  ✅ .env: $key → $HOME/.ssh/$name"
    done < <(grep -E '^(MEDIA|TUNNEL)_SSH_KEY=' "$TARGET/.env" | cut -d= -f2-)
    rm -f "$TARGET/.env.bak"
  else
    echo "  （会把 .env 里 pem 的绝对路径改成本机 ~/.ssh/…）"
  fi
fi

echo "⑤ 百度网盘 CLI 授权凭据"
mkdir -p "$HOME/.config/bdpan"
if [ -d "$S/bdpan" ]; then
  # ⚠️ 必须显式带上 .[!.]*：`.token_key` 是点开头文件，普通 * 匹配不到（会静默漏掉授权密钥）
  for f in "$S"/bdpan/* "$S"/bdpan/.[!.]*; do
    [ -f "$f" ] || continue
    run ".config/bdpan/$(basename "$f")" cp -p "$f" "$HOME/.config/bdpan/"
  done
  [ $APPLY -eq 1 ] && chmod 600 "$HOME"/.config/bdpan/* "$HOME"/.config/bdpan/.[!.]* 2>/dev/null
fi

echo "⑥ 本地隧道脚本与开机自启"
mkdir -p "$HOME/bin" "$HOME/Library/LaunchAgents"
if [ -d "$S/bin" ]; then
  for f in "$S"/bin/*.sh; do [ -e "$f" ] || continue; run "~/bin/$(basename "$f")" cp -p "$f" "$HOME/bin/"; done
  [ $APPLY -eq 1 ] && chmod +x "$HOME"/bin/*.sh 2>/dev/null
  if [ -x "$S/bin/bdpan" ]; then
    mkdir -p "$HOME/.local/bin"
    run "~/.local/bin/bdpan"  cp -p "$S/bin/bdpan" "$HOME/.local/bin/bdpan"
    [ $APPLY -eq 1 ] && chmod +x "$HOME/.local/bin/bdpan"
  fi
fi
for p in "$S"/launchagents/*.plist; do
  [ -e "$p" ] || continue
  run "~/Library/LaunchAgents/$(basename "$p")" cp -p "$p" "$HOME/Library/LaunchAgents/"
done

echo "⑦ 装依赖（npm ci，按 lock 文件锁版本）"
if [ $APPLY -eq 1 ]; then
  ( cd "$TARGET" && npm ci >/tmp/npm-ci.log 2>&1 ) && echo "  ✅ npm ci 完成" || { echo "  ❌ npm ci 失败，见 /tmp/npm-ci.log"; FAILED=$((FAILED+1)); }
else
  echo "  （将执行：cd $TARGET && npm ci）"
fi

echo
echo "═══ $([ $APPLY -eq 1 ] && echo '恢复完成' || echo '预演结束') ═══"
[ $FAILED -gt 0 ] && echo "⚠️ 有 $FAILED 步失败，别急着用，先看上面 ❌"

cat <<'TODO'

接下来必须你亲手做的：
  1) 路径检查（用户名不是 noonebook 时必做）
       grep -rn "/Users/noonebook" ~/bin/*.sh ~/Library/LaunchAgents/*.plist
       # 有命中就替换成你的实际家目录
  2) 装载开机自启（本机沙箱装不上，必须你自己终端跑）
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fmkj.admin-forward.plist
       launchctl list | grep fmkj
       ⚠️ Windows / WSL 没有 launchd：Windows 用包里的 windows-tunnel.ps1，
          WSL 直接把 ~/bin/fmkj-admin-forward.sh 放后台跑，见 docs/迁移到Windows.md
  3) 跑验证清单：见 docs/迁移到新电脑.md 第 5 节（8 项全过再开工）
TODO
