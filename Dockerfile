# 本项目的**统一基础镜像** —— 所有常驻服务共用这一个。
#
# 服务（都在 docker-compose.yml 里）：
#   gateway       闲管家「虚拟货源」回调网关        8787
#   tunnel-xgj    反向隧道：闲管家链路（服务器 8787）—
#   tunnel-wechat 反向隧道：微信链路（服务器 8899）  —
#   wechat-serve  微信公众号关键词自动回复          8899
#   admin         本机运营台                        8790
#
# 共用一个镜像的理由：它们要的东西高度重叠（node + tsx + 源码），
# 分开建只会让「哪份代码跑在哪个容器里」变模糊 —— 而这是本项目的已知痛点。
#
# ── 镜像里装了什么、为什么
#   tsx            源码是 .ts，直接跑不编译，避免引入构建产物的不一致
#   openssh-client ① 反向隧道（tunnel-ssh.mjs 调 ssh）
#                  ② 运营台传商品图到图床（media.ts 调 scp）
#   tesseract-ocr  图片体检的 OCR 引擎。macOS 那份用 Vision（swiftc 现编）；
#   + chi_sim/eng  Linux 没有 Vision，改用 tesseract —— 见 scripts/lib/ocr.mjs。
#                  ⚠️ 它**没有图像分类**能力（Vision 有），运行时会把覆盖率报出来。
#
# ── 密钥一律不烤进镜像
#   全部由 docker-compose 在运行时注入（environment + 只读挂载的私钥）。
#
# ── 基础镜像留成 ARG
#   本机 DNS 对 Docker Hub 有污染，拉不动时可退回本地已有镜像：
#     docker compose build --build-arg NODE_IMAGE=node:22-slim
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# 系统依赖放最前面：它变得最少，能吃到最长的那层缓存
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-client \
      tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷清单再装依赖，利用层缓存：以后改源码不会触发重新下载
COPY package.json package-lock.json tsconfig.json ./
COPY packages/bdpan-core/package.json      packages/bdpan-core/package.json
COPY packages/xgj-gateway/package.json     packages/xgj-gateway/package.json
COPY packages/mcp-server/package.json      packages/mcp-server/package.json
COPY packages/goofish-adapter/package.json packages/goofish-adapter/package.json

# 注意：不能加 --omit=dev（tsx 属于 devDependencies），
# 也不能加 --omit=optional（esbuild 的平台二进制是 optionalDependencies，缺了 tsx 直接跑不起来）。
#
# 用 npmmirror 而不是官方源：本机实测官方源 2.5s、npmmirror 0.11s，
# 且 package-lock 里的 resolved 指向官方源，需要一并改写才会走镜像。
RUN sed -i 's|https://registry\.npmjs\.org|https://registry.npmmirror.com|g' package-lock.json \
 && npm ci --registry=https://registry.npmmirror.com \
 && npm cache clean --force

# 再拷源码。三条都要：
#   packages/  各服务的实现
#   scripts/   ① 隧道与微信回复服务本身（.mjs）
#              ② 运营台运行时会动态 import scripts/lib/preflight.mjs（体检规则只能有一份）
#   assets/_shared/  违禁词表。⚠️ 这是**闸门的规则本身，不是数据** —— 必须跟着代码走。
#                    没有它，容器里的体检连规则都加载不了（preflight.mjs 读 ROOT/assets/_shared）。
COPY packages/ ./packages/
COPY scripts/ ./scripts/
COPY assets/_shared/ ./assets/_shared/

# 数据目录（商品目录 / 卡密池 / 订单台账），由 compose 挂载出来做持久化
ENV XGJ_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787

# ⚠️ 健康检查**故意不写在镜像里** —— 这个镜像被 5 个服务共用，
#    网关的 /__health 探针对隧道和微信服务毫无意义，写在镜像里会把它们全标成 unhealthy。
#    改为在 docker-compose.yml 里按服务声明。
CMD ["npx", "tsx", "packages/xgj-gateway/src/cli/serve.ts"]
