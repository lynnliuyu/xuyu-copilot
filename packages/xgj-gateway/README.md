# 闲管家虚拟货源网关

把**闲管家（闲鱼管家）的自动发货**接进你自己的系统：闲管家在买家下单时调用本服务，
本服务返回卡密（或任何一段文本内容），闲管家再把它发给买家。

- **零运行时依赖**：只用 Node 内置模块，打包后是单个 `server.mjs`
- **可独立 Docker 部署**：两阶段构建，运行镜像里没有 node_modules / 源码
- **数据源可插拔**：默认用 JSON 文件；也可以实现一个接口，接你自己的数据库

> ⚠️ **方向别记反**：本服务是**闲管家来调你**（虚拟货源协议）。
> 反过来「你调闲管家」（上架商品、查订单）走的是**开放平台协议**，域名、签名完全不同，不在这里。

---

## 一、三分钟跑起来

```sh
cp .env.example .env      # 改里面的四个值，见下
docker compose up -d --build
docker compose logs -f gateway
curl http://127.0.0.1:8787/__health
```

起来后，把这个服务**公网可达**的地址填到：

> 闲管家 → 我的应用 → 应用详情 → **货源授权信息 → 接口网关**

### 四个必填值，来源不同（最常见的对接失败原因）

| 变量 | 从哪来 | 填到闲管家的哪里 |
| --- | --- | --- |
| `XGJ_MCH_ID` | **你自己定**，比如 `my-shop-001` | 货源授权信息 → **AppKey** |
| `XGJ_MCH_SECRET` | **你自己定**，建议 32 位随机串 | 货源授权信息 → **AppSecret** |
| `GOOFISH_APP_KEY` | 闲管家「应用概况」里的 **AppKey** | 不用填，用于验签 |
| `GOOFISH_APP_SECRET` | 闲管家「应用概况」里的 **AppSecret** | 不用填，用于验签 |

官方原话：自研系统只有一个商户，`mch_secret`「能保证签名不易破解即可」。

### ⚠️ 顺序很重要

闲管家点「应用**上线**」的那一瞬间，就会来请求 `查询平台信息` + `查询商户信息` 做连通性校验。

**必须先让本服务公网可达，再去点上线。** 否则上线直接失败。

---

## 二、协议契约

所有接口都是 **POST + JSON**，鉴权参数放在 **query 串**。返回统一信封：

```jsonc
{ "code": 0, "msg": "OK", "data": { } }   // code=0 才是成功
```

### 签名（对不上就是 401，逐字节都不能差）

```js
// sign = md5( "app_id,app_secret,md5(body),timestamp,mch_id,mch_secret" )
const bodyString = JSON.stringify(body);   // 压缩 JSON，无空格，参数不排序
const sign = md5([appId, appSecret, md5(bodyString), timestamp, mchId, mchSecret].join(','));
```

请求：

```
POST {你的网关}/goofish/goods/list?mch_id=<XGJ_MCH_ID>&timestamp=<秒>&sign=<sign>
Content-Type: application/json
Body: <bodyString 原文>
```

**签名覆盖的是「实际发送的那些字节」。** 所以：

- 无 body 时用 `md5("{}")` 或 `md5("")`，两种都要能验
- 反过来，如果你对 `{"a":1}` 签名却发送 `{ "a": 1 }`，必然 401

自检向量（用来确认你的实现没写错）：

```
app_id=677859093659717  app_secret=wK63PxlOBaY9NoqMksLeZySzGIW25ifA
mch_id=100              mch_secret=o9wl81dncmvby3ijpq7eur456zhgtaxs
timestamp=1724414553    body={"goods_type":1,"goods_no":"12344532"}
→ sign = f8677927fd8421a75718e8cfaaf92221
```

### 接口清单

**必须实现**（否则闲管家后台保存货源会直接失败）：

| 路径 | 作用 | 关键点 |
| --- | --- | --- |
| `/goofish/open/info` | 查询平台信息 | `app_id` 必须**原样回传**应用的 AppKey，且是整数 |
| `/goofish/user/info` | 查询商户信息 | `balance` 必须 **> 0**，否则保存失败 |
| `/goofish/goods/list` | 查询商品列表 | `keyword` 要同时支持**名称模糊**与**编码精准** |
| `/goofish/goods/detail` | 查询商品详情 | 见下方必填字段 |

**卡密发货还需要**：

| 路径 | 作用 | 关键点 |
| --- | --- | --- |
| `/goofish/goods/change/subscribe` | 订阅商品变更 | ⚠️ 顺序是 `list → subscribe → detail`，**订阅失败会中断整个配置流程** |
| `/goofish/order/purchase/create` | 创建卡密订单 | 闲管家调你取卡，**必须幂等** |
| `/goofish/order/detail` | 查询订单详情 | 管家核验用 |

**本网关不实现**（按需自行扩展）：`/goofish/order/recharge/create`（直充）。
它不是 404，而是返回 `code=1` 便于排查。

### 商品对象必填字段

```
goods_no      商品编码（对上网盘资源编号，如 BD-GFX-123）
goods_type    1=直充 / 2=卡密 / 3=券码
goods_name    商品名称
price         价格，单位**分**
stock         库存
status        1=在架 / 2=下架
update_time   秒级时间戳
```

### 下单请求与响应

闲管家 POST 给你：

```jsonc
{ "order_no": "5127878449071040401", "goods_no": "BD-ARTCRAFT", "buy_quantity": 1,
  "max_amount": 288,          // 商家可接受的最大成本（分）
  "item_id": 1090239315273, "product_id": 1800364302878213 }
```

你同步返回：

```jsonc
{ "code": 0, "msg": "OK", "data": {
    "out_order_no": "SRC...", "order_no": "5127878449070401",
    "order_status": 20, "order_amount": 288, "order_time": 1792465810, "end_time": 1792465810,
    "goods_no": "BD-ARTCRAFT", "goods_name": "...", "buy_quantity": 1,
    "card_items": [ { "card_no": "下载链接", "card_pwd": "提取码" } ] } }
```

**同步返回成功且带 `card_items` 时，不需要 notify_url 回调。**

### 错误码

| code | 含义 | 什么时候返回 |
| --- | --- | --- |
| 0 | 成功 | |
| 401 | 签名错误 | Sign 对不上 |
| 403 | IP 不在白名单 | 仅当开启 `XGJ_IP_WHITELIST` |
| 408 | 时间戳过期 | 超过容差（默认 300s） |
| 1000 | 商户不存在 | `mch_id` 与配置不符 |
| 1100 | 商品不存在 | |
| 1101 | 商品不可用 | 已下架 |
| 1102 | 商品库存不足 | 卡密不够 |
| 1200 | 订单不存在 | |
| 1201 | 下单参数错误 | 缺必填参数 |
| 1202 | 下单金额低于成本价 | 金额 > `max_amount` |
| 1 | 请求错误 | 未知路径 / 非法 JSON / 配置缺失 |

校验顺序刻意与官方一致：**商户(1000) → 时间戳(408) → 签名(401)**，
这样排查时能一眼看出卡在哪一环，而不是所有问题都笼统报 401。

---

## 三、接你自己的数据源

默认是 JSON 文件存储（`XGJ_DATA_DIR`，默认 `/data`）。要接数据库/HTTP，实现 `GatewayStore` 即可：

```ts
import { createServer, loadConfig, type GatewayStore } from '@bdpan/xgj-gateway';

const store: GatewayStore = {
  location: 'postgres://...',
  merchant: () => ({ mch_id: 'my-shop-001', balance: 99999900 }),  // balance 必须 > 0
  loadCatalog: () => ({ merchant: myMerchant(), goods: allGoods() }),
  saveCatalog: (c) => { /* ... */ },
  findGoods: (no) => db.goods.find(no),
  goodsWithStock: (g) => ({ ...g, stock: db.stock(g.goods_no) }),
  availableStock: (no) => db.stock(no),
  cardPool: () => db.cards.all(),
  saveCardPool: (p) => { /* ... */ },
  isShared: (g) => g.stock_mode === 'shared',
  claimCards: (no, qty, orderNo) => db.cards.claimAtomic(no, qty, orderNo),  // ⚠️ 必须原子
  releaseCards: (orderNo) => db.cards.release(orderNo),
  loadOrders: () => db.orders.all(),
  findOrder: (no) => db.orders.find(no),
  saveOrder: (o) => db.orders.save(o),
  subscribeGoods: (r) => db.subs.save(r),
  unsubscribeGoods: (no, tk) => db.subs.remove(no, tk),
  listSubscriptions: () => db.subs.all(),
};

createServer({ config: loadConfig(), store }).listen(8787);
```

想先看一个能跑的骨架，直接读 `createMemoryStore()`（`src/store.ts`）——
把里面每个方法换成你的数据库调用就是完整实现。

### 三种库存模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `pool`（默认） | 一单一链。每条卡密只发一次，发完自动下架 | 每条内容都能单独作废 |
| `shared` | 一链多发。同一份内容重复发给所有买家，不消耗 | 没有分享 API、要规模化时（本项目用这个） |

`shared` 模式的代价：链接可被转卖，只能靠「有效期 + 定期轮换」约束。

---

## 三点五、一个网关能服务多少项目

身份模型很简单：**一个进程 = 一个货源身份（`mch_id` + 对应的一套 AppKey/AppSecret）**。

| 维度 | 上限 | 说明 |
| --- | --- | --- |
| 闲管家**应用/账号** | **1 个** | 签名验签用的是这一套 AppKey/AppSecret |
| 闲鱼**店铺** | **不限** | 一套 AppKey 可授权多个店铺（本项目实测：1 个 AppKey 挂 2 个店） |
| **项目 / 商品线** | **不限** | 商品是你返回的一个列表，随便放多少条 |
| 商品数 | 不限（建议分页 ≤100/页） | 见「部署要注意的坑」第 2 条 |

### 所以：同一个闲管家账号下的多个项目，**一个网关就够**

不需要为每个项目起一个容器。你要做的只有一件事——**给 `goods_no` 加项目前缀**，避免不同项目的编号撞车：

```
PROJA-0001     项目 A 的资源
PROJB-0001     项目 B 的资源
```

然后让 `GatewayStore` 返回合并后的列表（前缀不同，天然不会冲突）。
如果两个项目连数据源都不同（一个读 JSON、一个查数据库），
在 store 里按前缀路由即可 —— 这正是 `GatewayStore` 是接口而不是固定实现的原因。

### 多个闲管家**账号**才需要多个实例

比如你有两个闲管家账号（或两个独立应用），那就跑两份。compose 里复制一份 service 就行：

```yaml
services:
  gateway-a:
    build: .
    environment:
      XGJ_MCH_ID: project-a
      XGJ_MCH_SECRET: ${A_MCH_SECRET}
      GOOFISH_APP_KEY: ${A_APP_KEY}
      GOOFISH_APP_SECRET: ${A_APP_SECRET}
    volumes: [ ./data-a:/data ]
    ports: [ "8787:8787" ]

  gateway-b:
    build: .
    environment:
      XGJ_MCH_ID: project-b
      XGJ_MCH_SECRET: ${B_MCH_SECRET}
      GOOFISH_APP_KEY: ${B_APP_KEY}
      GOOFISH_APP_SECRET: ${B_APP_SECRET}
    volumes: [ ./data-b:/data ]
    ports: [ "8788:8787" ]
```

**为什么不做成「一个实例多账号」**：那需要在验签前先按 `mch_id` 查密钥表，
并让每个请求带上「当前是哪个商户」的上下文（`open/info` 要回对应的 `app_id`，
商品列表也要按商户隔离）。约 40 行改动，但收益不大、隔离性还更差。
真想合并再找我要；否则**多起一个容器是更安全的选择**。

> 顺带说：如果两个账号错配到一个实例上，行为是**明确报错**（`code=1000 商户不存在`），
> 不会静默串数据。所以「一个实例一个账号」是安全的默认。

---

## 四、部署要注意的坑（都是实测踩出来的）

1. **闲管家会先用 GET 探测你的接口。** 一律回 405 会让它判定「接口不可用」，
   于是**真实订单根本不发过来**。已知路径的 GET 必须回 `{"code":0,"msg":"OK"}`（本网关已处理）。

2. **`goods/list` 慢一点，后台就填不了商品。** 我们曾对每个商品读一次大 JSON →
   9.5 秒 → 闲管家的下拉框超时，表现为「关联商品填不了」。库存计算请务必缓存。

3. **`goods_type` 两边枚举不一致会静默返回空列表**，报「获取货源商品失败」。
   本网关对 1/2 都放行 —— 你自己的实现也建议宽容处理。

4. **反代后面必须关掉 IP 白名单**（`XGJ_IP_WHITELIST=false`）。
   `X-Forwarded-For` 可以伪造：加一个 header 就能冒充闲管家出口 IP。
   **真正的安全边界只有签名**（`app_secret` + `mch_secret`）。

5. **下单必须幂等。** 闲管家会重试；不记账就会同一单扣两次卡。
   本网关用 `order_no` 做幂等键。

6. **扣库存要原子。** 换数据库时别用「先查再写」，要用条件更新或事务。

7. **卡密有长度上限**（实测约 220 字报 `卡密长度超过限制`）。
   长文案要拆成 `card_no`（链接）+ `card_pwd`（提取码）。

8. **时区/时钟**：时间戳容差默认 300 秒，服务器时钟漂移会导致莫名其妙的 408。

---

## 五、本地开发（不用 Docker）

```sh
npm run serve        # 需要仓库根的 tsx；独立仓库会自动 npx 拉一个
npm run selftest     # 37 项端到端自检，完全模仿闲管家调用方式
npm run bundle       # 打包成 dist/server.mjs
npm start            # 跑打包产物
npm run verify       # 验收「已部署」的实例（可打远程地址）
```

**验收任何一套部署**（本机容器、远程服务器、已上线的公网地址都行）：

```sh
XGJ_MCH_ID=... XGJ_MCH_SECRET=... GOOFISH_APP_KEY=... GOOFISH_APP_SECRET=... \
  node verify.mjs https://your-gateway.example.com
```

它按官方规则算签名，跑 24 项检查（基础接口 / 商品 / 下单幂等 / 错误码 / 鉴权 / GET 探测）。

数据目录默认是包的 `data/`，可用 `XGJ_DATA_DIR` 覆盖。
首次启动若没有 `catalog.json`，会自动生成两个联调样例商品（`BD-DEMO-001` 池模式、`BD-DEMO-002` 共享模式）。

---

## 六、文件说明

```
src/
  config.ts     环境变量与配置校验（零依赖，自带极简 .env 解析）
  types.ts      协议类型与枚举
  sign.ts       虚拟货源签名
  store.ts      数据层：GatewayStore 接口 + JSON 文件实现 + 内存实现
  handlers.ts   各接口业务逻辑（createHandlers(store) 可注入数据源）
  server.ts     HTTP 层：验签、GET 探测放行、日志
  index.ts      公共 API（嵌入用）
  cli/serve.ts  启动入口
  cli/selftest.ts  端到端自检
  cli/import-goods.ts  批量导入商品与卡密
Dockerfile        两阶段构建（esbuild → 精简运行镜像）
docker-compose.yml
.env.example
```

---

## 七、想扩展

- **直充**：实现 `/goofish/order/recharge/create`，并从 `unimplemented` 集合里移除
- **异步发货**：下单时先返回处理中，保存 `order_no → notify_url`，完成后再回调闲管家
  （同步返回能搞定就别引入异步，链路短、无状态、失败立刻可见）
- **自动调价**：需要实现订阅推送，反过来调闲管家的「商品回调通知」

扩展点在 `handlers.ts`：`routes` 就是「路径 → 处理函数」的普通对象，
`createHandlers()` 接受你自己的实现拼进去即可。
