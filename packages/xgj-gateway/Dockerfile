# 闲管家「虚拟货源」网关 —— 独立镜像
#
# 两阶段构建：先用 esbuild 把 TS 打成单个 JS，再放进精简运行镜像。
# 结果镜像里没有 node_modules、没有 tsx、没有源码 —— 只有一个 server.mjs。
#
#   docker build -t xgj-gateway:local .
#   docker compose up -d
#
# 基础镜像留成 ARG：本机 DNS 对 Docker Hub 有污染时，
# 可以退回本地已有镜像：
#   docker build --build-arg NODE_IMAGE=node:22-slim -t xgj-gateway:local .

ARG NODE_IMAGE=node:22-alpine

# ────────────────────────────────────────────── 打包阶段
FROM ${NODE_IMAGE} AS builder
WORKDIR /build

# esbuild 固定版本：版本一变打包结果就可能不同，这里显式钉住
ARG ESBUILD_VERSION=0.28.2
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx --yes esbuild@${ESBUILD_VERSION} src/cli/serve.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=esm \
      --legal-comments=none \
      --outfile=dist/server.mjs \
 && node --check dist/server.mjs

# ────────────────────────────────────────────── 运行阶段
FROM ${NODE_IMAGE}

ENV NODE_ENV=production \
    XGJ_DATA_DIR=/data \
    XGJ_PORT=8787

WORKDIR /app

# 唯一的构建产物。密钥一律运行时注入，绝不烤进镜像。
COPY --from=builder /build/dist/server.mjs ./server.mjs

# 数据卷：商品目录 / 卡密池 / 订单台账。属主给非 root 用户
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# 探针不需要签名，也不依赖任何外部服务
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.XGJ_PORT||8787)+'/__health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
