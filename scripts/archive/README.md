# scripts/archive —— 一次性脚本归档

这里放的是**已经完成使命、不再被任何流程调用**的脚本。没有删，是因为它们记录了"当时怎么修的"，
排查历史数据问题时可能还要翻。

**判定标准**（2026-10-19 整理时按这三条筛的）：不在 `package.json` 的 scripts 里、文档里没提、
其他脚本也没引用它。

## 这里都有什么

| 文件 | 当时干什么的 | 现在归谁 |
|---|---|---|
| `curate-netdisk.mjs`、`netdisk-curated-media.mjs`、`netdisk-curation-snapshot.mjs`、`netdisk-refine-software.mjs`、`netdisk-preview-images.mjs`、`netdisk-all-previews.mjs`、`netdisk-fix-directory-moves.mjs` | 2026-10-09 那轮网盘大整理的中间步骤（选品、抓预览图、改目录） | `npm run tree:netdisk` → `media:netdisk` → `site:netdisk` 三件套已取代 |
| `gen-artcraft-docs.py`、`add-artcraft-resources.py`、`artcraft-assoc-table.py` | ArtCraft 套件的文档生成与资源登记 | 手册改由 `node scripts/artcraft-manual.mjs` 出；资源信息在 `scripts/artcraft-manual-data.mjs` |
| `_apply-artcraft-imgv2.py`、`_build-drip-queue.py`、`_fix-netdisk-dupnames.py`、`_restore-item-ids.py` | 几个一次性数据修复（换商品图 v2、重建滴灌队列、清网盘重名、回填 item_id） | 修复已完成；要看当时改了什么就翻这里 |
| `_kami-inspect.ts`、`_probe-kami-storage.ts`、`_probe-quota.ts`、`_t-title.ts` | 卡密接口 / 额度 / 标题权重的探测小工具 | 结论已写进 `assets/_shared/banned-words.json` 与记忆库 |

## 想捞回来

```bash
git mv scripts/archive/<文件> scripts/        # 或用 mv
```

⚠️ 从 `archive/` 挪回 `scripts/` 后，**相对路径要检查**：这些脚本里大多用 `path.resolve(__dirname, '..')`
找项目根，放在 `scripts/archive/` 下会多一层，直接跑会指错目录。
