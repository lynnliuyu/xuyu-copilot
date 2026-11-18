#!/usr/bin/env bash
# 多连接并行分片下载器（用于官方站单连接被限速的场景）
#
# 背景：download.xnview.com / mediaarea.net 单连接实测只有 20–26 KB/s，
#       16 连接并行 + 直连可到 ~850 KB/s（约 40 倍）。
#
# 用法：
#   scripts/fetch-parallel.sh <url> <输出文件> [连接数]
#   PROXY=1 scripts/fetch-parallel.sh <url> <out>      # 强制走代理（默认直连）
#
# 特性：分片断点续传（重跑只补没下完的片）、完成后校验总大小、自动清理分片。

set -uo pipefail

URL="${1:?用法: fetch-parallel.sh <url> <out> [conns]}"
OUT="${2:?缺少输出文件}"
CONNS="${3:-16}"
PARTS="$OUT.parts"

# 默认直连（实测比走代理快 3 倍）；PROXY=1 时走系统代理
EXTRA=()
if [ -z "${PROXY:-}" ]; then EXTRA=(--noproxy "*"); fi
PROXYDESC="直连"; [ -n "${PROXY:-}" ] && PROXYDESC="走系统代理"

mkdir -p "$PARTS"

# ---- 1. 探测支持情况 ----
HDR=$(curl -sIL --max-time 30 "${EXTRA[@]}" "$URL" | tr -d '\r')
LEN=$(printf '%s\n' "$HDR" | awk 'tolower($1)=="content-length:"{v=$2} END{print v}')
RANGES=$(printf '%s\n' "$HDR" | awk 'tolower($1)=="accept-ranges:"{print $2}' | tail -1)

if [ -z "$LEN" ]; then echo "❌ 拿不到 Content-Length，请改用普通下载"; exit 1; fi
if [ "$RANGES" != "bytes" ]; then
  echo "⚠️  服务端不支持分片（accept-ranges: ${RANGES}），请改用普通下载"; exit 2
fi

echo "总大小 : $((LEN/1048576)) MB  (${LEN} bytes)"
echo "连接数 : $CONNS      $PROXYDESC"

CHUNK=$(( (LEN + CONNS - 1) / CONNS ))
START_TS=$(date +%s)

# ---- 2. 逐片下载（已有的跳过 / 断点续传）----
for i in $(seq 0 $((CONNS-1))); do
  s=$(( i * CHUNK ))
  e=$(( s + CHUNK - 1 ))
  [ "$e" -ge "$LEN" ] && e=$(( LEN - 1 ))
  [ "$s" -ge "$LEN" ] && continue
  want=$(( e - s + 1 ))
  part="$PARTS/p$i"
  have=0
  [ -f "$part" ] && have=$(wc -c < "$part" | tr -d ' ')
  if [ "$have" -gt "$want" ]; then
    echo "  p$i 分片偏大（${have} > ${want}），丢弃重下"
    rm -f "$part"; have=0
  fi
  if [ "$have" -eq "$want" ]; then echo "  p$i 已完成，跳过"; continue; fi

  # 续传：不用 curl -C -（它与显式 -r 组合是「追加」语义，会把分片撑坏），
  # 改为把区间起点推到已下载的位置，再把缺的尾巴 append 上去。
  rs=$(( s + have ))

  echo "  p$i 取 $((s/1048576))–$((e/1048576)) MB（已有 $((have/1048576)) MB，从 $((rs/1048576)) MB 续）"
  (
    for try in 1 2 3 4 5; do
      if curl -s "${EXTRA[@]}" -r "$rs-$e" \
           --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 3600 \
           >> "$part" "$URL"; then break; fi
      sleep 3
    done
  ) &
done
wait

# ---- 3. 校验并合并 ----
total=0
for i in $(seq 0 $((CONNS-1))); do
  part="$PARTS/p$i"
  [ -f "$part" ] && total=$(( total + $(wc -c < "$part" | tr -d ' ') ))
done

if [ "$total" -ne "$LEN" ]; then
  echo "❌ 大小不符：得到 $total / 期望 $LEN —— 分片已保留，重跑本命令可续传"
  exit 3
fi

: > "$OUT"
for i in $(seq 0 $((CONNS-1))); do
  [ -f "$PARTS/p$i" ] && cat "$PARTS/p$i" >> "$OUT"
done
rm -rf "$PARTS"

ELAPSED=$(( $(date +%s) - START_TS ))
[ "$ELAPSED" -eq 0 ] && ELAPSED=1
awk -v o="$OUT" -v b="$LEN" -v s="$ELAPSED" \
  'BEGIN{ printf "✅ 完成 %s  %.1f MB  用时 %ds  平均 %.0f KB/s\n", o, b/1048576, s, b/1024/s }'
