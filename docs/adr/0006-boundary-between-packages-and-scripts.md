# 业务逻辑住 packages，scripts 只做接线

`scripts/` 有 89 个文件、15121 行，比它操作的库（`packages/` 下 9184 行 TypeScript）还大。大不是问题——问题是**没有一条规则说「什么该放哪」**，于是同一台「挑候选 → 过闸门 → 提交 → 等异步落地 → 用 `item_id` 核验 → 记台账 → 灌卡密」的状态机被独立实现了五遍：`drip-publish.mjs`、`republish-stuck.ts`、`publish-queue.ts`、`artcraft-publish.ts`、以及 `public/index.html` 里的 `publishList`。

五份实现已经走样，不是风格差异而是行为差异：其中两份（`publish-queue.ts`、`index.html`）在提交后只看接口返回的 ok 就算成功——这个判定在 2026-10-08 就被推翻了（286 个商品「接口受理成功」但停在草稿箱）；五份里只有 `drip-publish.mjs` 在每次发布后灌卡密池，其余四条路径都留着「已上架但卡密池为空」的窗口，而买家拍下时**不会有任何报错**。

包边界同样只写在声明里。四个包声明了 `name` 与 `exports`，`mcp-server` 甚至声明了 `"dependencies": {"@bdpan/core": "*"}`，但**全仓没有一处按包名 import**：跨包引用一律是 `../../<pkg>/src/<file>` 的深路径，穿到 `bdpan-core/src/env`、`goofish-adapter/src/api` 这一层。最重的一层 `xgj-admin` 连 `package.json` 都没有。于是 `workspaces: ['packages/*']` 这一行声明的是一个不存在的结构。

决定：**`packages/` 是唯一的业务逻辑归属地，`scripts/` 是 CLI 适配层。** 脚本只允许做三件事：解析参数、调用 `packages/` 的模块、打印结果。跨包引用走包名，不走深路径。

## Considered options

- **维持现状（脚本各自实现）**：写得最快，且代价已经付过了——五份编排、两份用着被推翻的判定、五条发布路径里只有一条灌卡密。
- **引入分层 / 依赖注入脚手架**：给一个单人操作的工装项目上框架级抽象。它的主要收益是团队边界与可替换实现，而这两个前提在这里都不成立。
- **把 `scripts/` 整体并进 `packages/`**：过度。脚本的一次性诊断用途（`_check-listing.ts`、`_enum-drafts.ts`）是真实的，不该被消灭。
- **本条：保留脚本作为表层，但把它定义为纯适配层**——保留速度，去掉第二套实现。

## Consequences

- 新需求仍然可以写脚本；但**同一段编排在 `scripts/` 里出现第二次即为违规**，第二次出现时就应该下沉。
- 共享的运行时状态文件各有一个**属主模块**：`drafts/.listings.json`、`drafts/.excluded.json`、`out/publish-guard.json`、`out/preflight-results.json`。别处只能通过属主模块读写，不再就地 `readFileSync` / `writeFileSync`。
- **反向依赖一律不允许**：`packages/` 不得 import `scripts/`。现状有一处违例——`packages/xgj-admin/src/publish-guard.ts` 在运行时用 `new URL` 反向 import `scripts/lib/preflight.mjs`——需要消除。
- 跨包引用改为包名（tsconfig `paths` 就够，不需要真发包）。`xgj-admin` 补上 `package.json`，或者明确承认它不是一个包、只是目录。
- 任何触及发布路径的下沉都必须走金丝雀纪律：先发 1 条、核对闲鱼侧 `item_id > 0`，再放量（见 ADR-0004）。
- 这条规则是**可机械检查**的：`scripts/` 里出现第二份「挑候选 / 提交 / 核验」循环，或出现 `../../<pkg>/src/` 深路径，即为违规。
