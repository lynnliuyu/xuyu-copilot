#!/bin/bash
# 生成「换电脑」迁移包：代码 + 草稿 + 台账 + 密钥/授权 + 记忆库 + 本地辅助脚本
#
# 用法：
#   bash scripts/_make-migration-bundle.sh              # 默认：包含 git 历史与 assets 里的代码类文件
#   bash scripts/_make-migration-bundle.sh --no-git     # 不含 git 历史（更小）
#   bash scripts/_make-migration-bundle.sh --with-assets # 连 assets 全量（+3G 图片与安装包）
#
# 产物：out/migrate/bdpan-goofish-migrate-<日期>.tar.gz.enc（AES-256 加密）
#       out/migrate/<同名>.sha256
# 密码：脚本随机生成并打印，务必记下（丢了只能重新打包）
#
# ⚠️ 两个已踩过的坑，别"优化"回去：
#   1. 密码不能用 `tr -dc ... < /dev/urandom | head -c 24` —— 本机沙箱会拦 /dev/urandom，整条命令静默挂死。
#   2. assets 不能整个排除 —— `assets/_shared/banned-words.json` 是 preflight 的必需词表，
#      缺了不会报错，只会让「上架体检」静默失效（= 发不出货也拦不住违禁词）。

set -uo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M)"
NAME="bdpan-goofish-migrate-$STAMP"
WORK="$PROJ/out/migrate"
STAGE="$WORK/$NAME"
TREE="$STAGE/tree"
WITH_GIT=1
WITH_ASSETS=0

for a in "$@"; do
  case "$a" in
    --no-git) WITH_GIT=0 ;;
    --with-assets) WITH_ASSETS=1 ;;
    *) echo "未知参数：$a"; exit 1 ;;
  esac
done

echo "═══ 打包中 ═══"
echo "项目：$PROJ"
rm -rf "$STAGE"; mkdir -p "$TREE"
mkdir -p "$STAGE/03-secrets/ssh" "$STAGE/03-secrets/bdpan" "$STAGE/03-secrets/bin" \
         "$STAGE/03-secrets/launchagents" "$STAGE/03-secrets/keys"

# ── 01 代码与数据（工作区实际内容，含未提交改动）────────────────────────────
# 用 rsync 精确收集，而不是 tar --exclude 整目录：这样能保留 assets 里的代码类文件。
echo "  · 收集代码与数据"
EXC="--exclude=node_modules/ --exclude=out/ --exclude=.git/ --exclude=netdisk-site/ \
     --exclude=.cache/ --exclude=.DS_Store --exclude=_migrate.log"
[ "$WITH_ASSETS" -eq 0 ] && EXC="$EXC --exclude=assets/"
rsync -a $EXC "$PROJ/" "$TREE/"

# assets 全量被排除时，补进「运行必需的代码类文件」：词表 / 封面模板 / 品牌图标 / 清单 json
if [ "$WITH_ASSETS" -eq 0 ]; then
  ( cd "$PROJ" && find assets -maxdepth 3 -type f \
      \( -name "*.json" -o -name "*.mjs" -o -name "*.py" -o -name "*.md" -o -name "*.svg" \
         -o -name "*.txt" -o -name "*.csv" \) -size -2M -print0 2>/dev/null \
    | rsync -a --from0 --files-from=- ./ "$TREE/" )
  echo "      assets 代码类文件：$(cd "$TREE" && find assets -type f | wc -l | tr -d ' ') 个"
fi

tar -czf "$STAGE/01-code.tar.gz" -C "$TREE" . 2>/dev/null
CODE_FILES=$(find "$TREE" -type f | wc -l | tr -d ' ')

# out/ 里那些只用过一次的运维脚本（滴灌器 / 推送器 / 修数据脚本）不在 git 里，
# 但都是「跑在 134 上」的关键工具 —— 只收代码类小文件，不收 PDF/图片/日志（那些占 5.5G）。
( cd "$PROJ" && find out -maxdepth 2 -type f \
    \( -name "*.mjs" -o -name "*.py" -o -name "*.sh" -o -name "*.ts" -o -name "*.json" -o -name "*.md" \) \
    -size -2M ! -name "_migrate.log" -print0 2>/dev/null \
  | rsync -a --from0 --files-from=- ./ "$STAGE/out-scripts/" )

if [ -d "$STAGE/out-scripts/out" ]; then
  # ⚠️ rsync 会保留 `out/` 这一层前缀 → 必须从 out-scripts/out 打包，
  # 否则解到 $TARGET/out 会变成 out/out/…（实测踩过）
  tar -czf "$STAGE/01b-out-scripts.tar.gz" -C "$STAGE/out-scripts/out" . 2>/dev/null
  OUTN=$(find "$STAGE/out-scripts" -type f | wc -l | tr -d ' ')
  if ! tar -tzf "$STAGE/01b-out-scripts.tar.gz" | grep -q "drip-shunhe.mjs"; then
    echo "      ⚠ 01b 未收进 drip-shunhe.mjs —— 检查 out/ 是否被筛掉了"
  fi
  echo "      01-code.tar.gz $(du -h "$STAGE/01-code.tar.gz" | cut -f1)（$CODE_FILES 个文件）"
  echo "      01b-out-scripts.tar.gz $(du -h "$STAGE/01b-out-scripts.tar.gz" | cut -f1)（$OUTN 个运维脚本）"
  rm -rf "$STAGE/out-scripts"
fi
rm -rf "$TREE"

# ── 02 git 历史（可回溯；不含未提交改动，改动已在 01 里）──────────────────────
if [ "$WITH_GIT" -eq 1 ]; then
  echo "  · 02-git.bundle（完整提交历史）"
  git -C "$PROJ" bundle create "$STAGE/02-git.bundle" --all >/dev/null 2>&1 \
    && echo "      $(du -h "$STAGE/02-git.bundle" | cut -f1)" \
    || echo "      ⚠ git bundle 失败（可忽略，01 已含工作区全部内容）"
fi

# ── 03 密钥 / 授权 / 本地状态（这些都不在 git 里，丢了要重配）────────────────
echo "  · 03-secrets/"
copy() { # copy <源> <目标相对路径>
  # ⚠️ 这里曾经写成 `cp ... 2>/dev/null && echo ✅`：
  #    目标父目录（03-secrets/drafts/、03-secrets/out/）没建 → cp 失败 → && 短路 →
  #    **一行都不打印**，包看起来「一切正常」，实际上**上架台账 755 条压根没进包**。
  #    新机上就等于失忆（会重复上架已有商品）。所以：建目录、不吞错误、失败记账。
  # ⚠️ 也别用 `local src="$1" rel="$2"` —— macOS 自带 bash 3.2 在 `set -u` 下，
  #    函数第二次被调用时会报 `rel: unbound variable`（实测，纯属 bash 3.2 的坑）。
  if [ ! -e "$1" ]; then echo "      ·  $2（本机没有，跳过）"; return 0; fi
  mkdir -p "$STAGE/03-secrets/$(dirname "$2")"
  if cp -p "$1" "$STAGE/03-secrets/$2"; then
    echo "      ✅ $2"
  else
    echo "      ❌ $2 复制失败"
    COPY_FAILED=$((COPY_FAILED+1))
  fi
}
COPY_FAILED=0

# 项目内、被 .gitignore 忽略的运行时状态
copy "$PROJ/.env"                        ".env"
copy "$PROJ/.tokens.json"                ".tokens.json"
copy "$PROJ/drafts/.listings.json"       "drafts/.listings.json"
copy "$PROJ/drafts/.excluded.json"       "drafts/.excluded.json"
copy "$PROJ/out/netdisk-shares.json"     "out/netdisk-shares.json"
copy "$PROJ/out/netdisk-index.json"      "out/netdisk-index.json"
copy "$PROJ/out/drip-shunhe-progress.json" "out/drip-shunhe-progress.json"
copy "$PROJ/out/drip-shunhe-codes.json"  "out/drip-shunhe-codes.json"

# SSH：连生产机 134 的私钥 + config
copy "$HOME/.ssh/xgj-134_ed25519"        "ssh/xgj-134_ed25519"
copy "$HOME/.ssh/xgj-134_ed25519.pub"    "ssh/xgj-134_ed25519.pub"
copy "$HOME/.ssh/config"                 "ssh/config"
chmod 600 "$STAGE/03-secrets/ssh/xgj-134_ed25519" 2>/dev/null

# .env 里引用的 pem（中继机 150.158.3.164 的密钥）：MEDIA_SSH_KEY 传商品图、TUNNEL_SSH_KEY 建反向隧道。
# ⚠️ 曾经漏收过 —— 包看起来完整，新机上 `npm run media:netdisk` 直接报找不到私钥。
#    只收「本机真实存在」的路径（134 上的 /opt/… 这种在 .env 里可能是另一套，不适用于本机）。
while IFS= read -r v; do
  [ -n "$v" ] || continue
  if [ -f "$v" ]; then
    cp -p "$v" "$STAGE/03-secrets/keys/" && chmod 600 "$STAGE/03-secrets/keys/$(basename "$v")" \
      && echo "      ✅ keys/$(basename "$v")"
  else
    echo "      ·  .env 引用的 $(basename "$v") 本机不存在，跳过"
  fi
done < <(grep -E '^(MEDIA_SSH_KEY|TUNNEL_SSH_KEY)=' "$PROJ/.env" 2>/dev/null | cut -d= -f2- | sort -u)

# 百度网盘 CLI 凭据（OAuth token）
for f in .token_key config.json disclaimer_accepted.json; do
  [ -e "$HOME/.config/bdpan/$f" ] && cp -p "$HOME/.config/bdpan/$f" "$STAGE/03-secrets/bdpan/$f" && echo "      ✅ bdpan/$f"
done

# 本地辅助脚本 + launchd
for f in fmkj-admin-forward.sh fmkj-wechat-serve.sh fmkj-wechat-tunnel.sh xgj-tunnel.sh; do
  [ -e "$HOME/bin/$f" ] && cp -p "$HOME/bin/$f" "$STAGE/03-secrets/bin/$f" && echo "      ✅ bin/$f"
done
for p in "$HOME/Library/LaunchAgents"/com.fmkj.*.plist; do
  [ -e "$p" ] && cp -p "$p" "$STAGE/03-secrets/launchagents/" && echo "      ✅ launchagents/$(basename "$p")"
done

# 网盘 CLI 二进制（Mach-O arm64；新机不是 Mac 就删掉重新下载）
if [ -x "$HOME/.local/bin/bdpan" ]; then
  cp -p "$HOME/.local/bin/bdpan" "$STAGE/03-secrets/bin/bdpan" && echo "      ✅ bin/bdpan（$(du -h "$HOME/.local/bin/bdpan" | cut -f1)）"
fi

# ── 硬断言：少了这两个，包就是废的 ──────────────────────────────────────────
# .env          → 网关密钥 / 闲管家 app_secret，缺了什么都跑不起来
# .listings.json → 上架台账（code → product_id / item_id），缺了新机等于失忆
for must in ".env" "drafts/.listings.json"; do
  if [ ! -s "$STAGE/03-secrets/$must" ]; then
    echo "❌ 致命：03-secrets/$must 没进包 —— 这样的包别发给新机"
    exit 1
  fi
done
[ "$COPY_FAILED" -gt 0 ] && { echo "❌ 有 $COPY_FAILED 个文件复制失败，先修好再打包"; exit 1; }
echo "      ✅ 硬断言通过（.env + 上架台账 都在包里：$(python3 -c "import json;print(len(json.load(open('$STAGE/03-secrets/drafts/.listings.json'))))" 2>/dev/null || echo '?') 条）"

# ── 04 环境快照（版本对齐用）────────────────────────────────────────────────
echo "  · 04-env.txt"
{
  echo "# 打包时的本机环境（新机尽量对齐）"
  echo "打包时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "主机: $(uname -s) $(uname -m) / $(sw_vers -productVersion 2>/dev/null)"
  echo "node: $(node -v 2>/dev/null)"
  echo "npm: $(npm -v 2>/dev/null)"
  echo "python3: $(python3 -V 2>&1)"
  echo "bdpan: $("$HOME/.local/bin/bdpan" --version 2>/dev/null | head -1)"
  echo "chrome: $([ -d '/Applications/Google Chrome.app' ] && echo 已安装 || echo 未安装)"
  echo "docker: $(docker --version 2>/dev/null || echo 未安装)"
  echo
  echo "# 生产机（黑豹X2）"
  echo "<SERVER_IP>  /opt/bdpan-goofish  镜像 bdpan-goofish:local"
} > "$STAGE/04-env.txt"

# ── 恢复脚本也放一份到包根目录（这样新机不用先解代码就能跑）─────────────────
cp -p "$PROJ/scripts/_restore-on-new-machine.sh" "$STAGE/restore.sh" \
  && chmod +x "$STAGE/restore.sh" && echo "  · restore.sh（macOS / Linux / WSL 用这个）"
cp -p "$PROJ/scripts/_restore-on-windows.ps1" "$STAGE/restore.ps1" \
  && echo "  · restore.ps1（Windows 原生 PowerShell 用这个）"
cp -p "$PROJ/scripts/_windows-tunnel.ps1" "$STAGE/windows-tunnel.ps1" \
  && echo "  · windows-tunnel.ps1（Windows 上替代 launchd 的端口转发）"

# ── 清单与校验 ──────────────────────────────────────────────────────────────
# ⚠️ tree/ 与 out-scripts/ 只是 tar 的中间产物，不该出现在包里。
#    这里**不靠**上面那两个 rm -rf —— 沙箱的 safe-delete 守卫会把批量删除拦下来（静默），
#    于是整份未压缩代码被一起打进包，体积从 13M 涨到 19M、checksums 多出 160 多个条目。
#    所以在 find / tar 层面再排除一次，删不掉也不影响结果。
EXCL_INTER='-path ./tree -prune -o -path ./out-scripts -prune -o'
( cd "$STAGE" && eval find . $EXCL_INTER -type f ! -name checksums.txt -print0 \
    | xargs -0 shasum -a 256 | sed 's|\./||' | sort -k2 > checksums.txt )
echo "  · checksums.txt（$(wc -l < "$STAGE/checksums.txt" | tr -d ' ') 个文件）"

# ── 打包 + 加密 ─────────────────────────────────────────────────────────────
echo "  · 压缩"
PLAIN="$WORK/$NAME.tar.gz"
# 排除 tree/ 与 out-scripts/：删不掉也必须不能进包（见上面 checksums 处的说明）
tar -czf "$PLAIN" -C "$WORK" \
  --exclude="$NAME/tree" --exclude="$NAME/out-scripts" "$NAME" || { echo "❌ tar 失败"; exit 1; }
echo "      $(du -h "$PLAIN" | cut -f1)"

echo "  · 加密"
PW="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
[ ${#PW} -eq 24 ] || { echo "❌ 密码生成异常（长度 ${#PW}）"; exit 1; }

ARCHIVE="$WORK/$NAME.tar.gz.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:"$PW" -in "$PLAIN" -out "$ARCHIVE" \
  || { echo "❌ 加密失败"; exit 1; }
rm -f "$PLAIN"
rm -rf "$STAGE"

( cd "$WORK" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256" )

echo
echo "═══ 完成 ═══"
echo "文件：$ARCHIVE"
echo "大小：$(du -h "$ARCHIVE" | cut -f1)"
echo "校验：$(cat "$ARCHIVE.sha256")"
echo
echo "┌──────────────────────────────────────────────┐"
echo "│ 解密密码（只显示这一次，请立刻记进密码管理器）│"
echo "│  $PW  │"
echo "└──────────────────────────────────────────────┘"
