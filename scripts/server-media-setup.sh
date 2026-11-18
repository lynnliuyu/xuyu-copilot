#!/usr/bin/env bash
#
# 图床服务器初始化 —— 在 150.158.3.164 上以 root 运行一次即可。
#
# 做三件事：
#   1. 建图片目录 /srv/goods-img 并给好权限
#   2. 确保有 Web 服务（优先复用已有的 nginx/Caddy，都没有才装 Caddy）
#   3. 让它把 https://api.fmkj.top/goods/ 指向那个目录
#
# 用法：
#   scp -i <key> scripts/server-media-setup.sh root@150.158.3.164:/tmp/
#   ssh -i <key> root@150.158.3.164 'bash /tmp/server-media-setup.sh'
#
set -euo pipefail

IMG_DIR="${IMG_DIR:-/srv/goods-img}"
DOMAIN="${DOMAIN:-api.fmkj.top}"
URL_PATH="${URL_PATH:-/goods}"

log()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  ⚠️  %s\033[0m\n' "$*"; }

log "1/4 建立图片目录 $IMG_DIR"
mkdir -p "$IMG_DIR"
chmod 755 "$IMG_DIR"
touch "$IMG_DIR/.keep"
chmod 644 "$IMG_DIR/.keep"
ok "目录就绪（$(df -h "$IMG_DIR" | tail -1 | awk '{print $4}') 可用）"

log "2/4 检测本机已有的 Web 服务"
HAS_CADDY=0; HAS_NGINX=0
command -v caddy >/dev/null 2>&1 && HAS_CADDY=1
command -v nginx >/dev/null 2>&1 && HAS_NGINX=1
echo "     caddy=$HAS_CADDY  nginx=$HAS_NGINX"

if [ "$HAS_CADDY" -eq 1 ]; then
  log "3/4 复用 Caddy：写入站点配置"
  CONF=/etc/caddy/Caddyfile
  BAK="${CONF}.bak.$(date +%s)"
  [ -f "$CONF" ] && cp "$CONF" "$BAK" && echo "     已备份原配置到 $BAK"

  # 若还没有该域名的站点块，就追加一个只做静态文件的站点
  if ! grep -q "root \* $IMG_DIR" "$CONF" 2>/dev/null; then
    cat >> "$CONF" <<EOF

# ---- 商品图图床（由 server-media-setup.sh 添加）----
$DOMAIN {
    handle_path $URL_PATH/* {
        root * $IMG_DIR
        file_server
        header Cache-Control "public, max-age=31536000"
    }
    # 其余请求落到原站点（若有）
    handle {
        respond "media host" 200
    }
}
EOF
    ok "已追加 $DOMAIN 站点配置"
  else
    warn "配置里已存在该目录，跳过写入"
  fi

  command -v systemctl >/dev/null 2>&1 && systemctl reload caddy 2>/dev/null || true
  ok "Caddy 已重载"

elif [ "$HAS_NGINX" -eq 1 ]; then
  log "3/4 复用 nginx：写入 location 片段"
  SNIP=/etc/nginx/snippets/goods-img.conf
  mkdir -p /etc/nginx/snippets
  cat > "$SNIP" <<EOF
# 商品图图床（由 server-media-setup.sh 生成）
location $URL_PATH/ {
    alias $IMG_DIR/;
    autoindex off;
    add_header Cache-Control "public, max-age=31536000";
}
EOF
  ok "已生成片段 $SNIP"
  warn "需要你把它 include 进对应 server 块，例如："
  echo "        server_name $DOMAIN;"
  echo "        include $SNIP;"
  echo "     然后执行：nginx -t && systemctl reload nginx"

else
  log "3/4 本机无 Web 服务，安装 Caddy（自带 HTTPS 证书申请）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null

  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    handle_path $URL_PATH/* {
        root * $IMG_DIR
        file_server
        header Cache-Control "public, max-age=31536000"
    }
    handle {
        respond "media host" 200
    }
}
EOF
  systemctl enable --now caddy >/dev/null 2>&1 || true
  ok "Caddy 已安装并启动"
fi

log "4/4 自检"
echo "     目录内容："
ls -la "$IMG_DIR" | sed 's/^/       /'
echo
warn "注意：域名 $DOMAIN 必须已解析到本机公网 IP，Caddy 才能申请到证书。"
echo "     验证命令（在本地跑）："
echo "       curl -I https://$DOMAIN$URL_PATH/.keep"
echo
ok "完成"
