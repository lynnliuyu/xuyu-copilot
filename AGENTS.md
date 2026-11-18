# bdpan-goofish

把百度网盘里的数字资源卖到闲鱼。

链路：网盘资源仓 → 选品 → 生成商品草稿 → **上架到闲鱼店铺（已跑通，212 件在售）** → 买家拍单 → 触发发货 → 出卡密 → 发给买家。

> ⚠️ **发货这一段目前是断的**（2026-10-19 核实）：上架走的是闲管家**进销存 API**，而自动发货只对闲管家
> **虚拟货源**体系里的商品生效，两边没接起来。**进销存侧累计 509 笔真实订单（¥2264.42），
> 最近 9 单里 8 单从未发货**（`order_status=21` 待发货压在线上）。
>
> 排查用 `npm run order:probe`（**只读**，只调 `order/list` 与 `order/kam/list`，没有任何写接口）；
> 加 `--copy` 会打印可直接复制给买家的补发文本。三条路线与里程碑见 `docs/项目整理与规划.md`。
> **别假设它能自动发货，也别在没授权时调 `dummy/send`。**

## 动手前先知道这几条

- **对外动作先预演。** 上架、发布、发货都是不可逆的对外行为；脚本默认走 `dry_run`，先看预演再真跑。
- **「成功」要回查。** 只认闲鱼侧 `item_id > 0`。平台返回成功不代表落地，返回失败也不代表没落地 —— 两种都要回查线上状态。
- **商品图必须用官方素材。** 每个商品的封面用**官方 UI 截图 + 官方图标**合成，做到一眼可辨；**不要**只做「一套模板换文字」（用户 2026-10-16 明确要求）。详见 `.workbuddy/memory/MEMORY.md` 的「商品图规范」。
- **先读铁律。** 改这个仓库里的任何东西之前，读 `.workbuddy/memory/MEMORY.md`。那里的每一条都是踩过的坑，重复踩的代价是钱和店铺。

## 上下文指针

按手头的任务选一处读，不要全读。

| 手头的事 | 去哪 |
| --- | --- |
| 拿不准某个词在本项目指什么 | `GLOSSARY.md` |
| 想知道当初为什么这么设计 | `docs/adr/` |
| 要上架、发布、发货，或排查这类故障 | `.workbuddy/memory/MEMORY.md` |
| 需要具体参数、清单、完整论述 | `.workbuddy/memory/REFERENCE.md` |
| 恢复上一次会话的进度 | `.workbuddy/memory/<YYYY-MM-DD>.md`，越晚越靠后 |
| 闲管家接口的签名与端点 | `packages/goofish-adapter/src/endpoints.ts` |
| 要把闲管家网关**独立部署/移植到别的项目** | `packages/xgj-gateway/README.md`（自带 Dockerfile + compose，零依赖；协议契约与坑都在里面） |
| 某个包负责哪一层 | 见下方「分层」 |
| 想生成 / 换商品图，或抓官方素材 | `.workbuddy/memory/MEMORY.md` 的「商品图规范」；工具 `scripts/fetch-artcraft-official.py`、`assets/_shared/card-artcraft.mjs`、`scripts/render-artcraft-cards.mjs` |
| 想知道流水线有哪几步、每步的入口是哪条命令 | `docs/流水线-七个阶段.md` |
| 想知道现在算什么阶段、下一步做什么、哪些能做哪些不能做 | `docs/项目整理与规划.md` |
| 要在这台机器之外继续开发 | `docs/迁移到新电脑.md`（macOS）/ `docs/迁移到Windows.md` |
| 需要找某个历史一次性脚本（网盘整理、数据修复） | `scripts/archive/README.md` |

## 分层

| 包 | 负责 |
| --- | --- |
| `packages/bdpan-core` | 百度网盘读写：上传、分享、目录 |
| `packages/mcp-server` | 把网盘能力暴露成 MCP 工具 |
| `packages/goofish-adapter` | 闲管家开放平台客户端，同时封装虚拟货源与进销存两套签名 |
| `packages/xgj-gateway` | 公网网关：接收闲管家回调、出卡密、管货源目录 |
| `packages/xgj-admin` | 管理端页面、资源注册表、草稿生成、发布护栏 |

## Agent skills

### Issue tracker

本地 markdown：issue 与 spec 都是 `.scratch/<feature>/` 下的文件。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用默认五个角色标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `GLOSSARY.md` 加 `docs/adr/`。见 `docs/agents/domain.md`。
