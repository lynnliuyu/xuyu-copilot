# Issue tracker: Local Markdown

本仓库的 issue 与 spec 以 markdown 文件形式存放在 `.scratch/` 下。

## Conventions

- 一个特性一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现工单每个一条文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，不合并成一个大文件
- triage 状态写在每个 issue 文件靠上位置的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 讨论与历史追加在文件底部 `## Comments` 标题下

## 当技能说「publish to the issue tracker」

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在就建）。

## 当技能说「fetch the relevant ticket」

读取对应的文件路径。通常由用户直接给出路径或编号。

## Wayfinding operations

供 `/wayfinder` 使用。**map** 是一张文件，每条工单一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（承载 Notes / Decisions-so-far / Fog 正文）
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题本身。`Type:` 行记录类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`
- **Blocking**：靠上位置的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时该工单解除阻塞
- **Frontier**：扫描 `.scratch/<effort>/issues/`，找开放、未阻塞、未被认领的文件；编号最小者优先
- **Claim**：动手前先写 `Status: claimed` 并保存
- **Resolve**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，然后把一条上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far

## 本仓库的说明

本仓库没有 git remote，是单人本地项目，因此选用本地 markdown 而非 GitHub Issues。日常的上架状态不在这里追踪——那是 `drafts/.listings.json` 台账的职责，见 `GLOSSARY.md`。
