# 开源软件公众号 · freeware 官方条款核查

> 2026-10-09 · 核查对象：`assets/free-software/manifest.json` 中 `source = "url"`（非 GitHub）的 5 条
> 核查方式：**读官方许可页 / 官方安装包内附 EULA 原文**，逐条摘录要点并判定「是否授予再分发权」
> 关联文件：`docs/开源软件公众号-首批选题与授权核验报告.md`（第四节 · 第八节 P2）

---

## 0. 一句话结论

| id | 项目 | 再分发权 | 结论 |
|---|---|---|---|
| `xnviewmp` | XnViewMP | ✅ **授予**（限非商业、须原样安装包） | 可分发，附条款摘录 + **不得商用**提示 |
| `mp3tag` | Mp3tag | ✅ **授予**（限非商业、须官方自解压安装包） | ⚠️ **仅 Windows 版可分发**（macOS 版是 App Store 付费应用） |
| `mediainfo` | MediaInfo（CLI） | ✅ **授予**（BSD-2-Clause，含二进制形式） | 可分发，保留版权声明与免责声明 |
| `mediainfo-gui` | MediaInfo GUI | ✅ **授予**（同上） | 可分发，⚠️ 官方 GUI 依赖 Qt，须随包同行 |
| `runjs` | RunJS | ❌ **未授予** | **移出「可打包」池**，只做介绍 + 官方下载引导 |

**一个必须记住的判据**：`免费使用 ≠ 可再分发`。
5 条里有 3 条（XnViewMP / Mp3tag）是**专有 freeware**，它们的 EULA 里**恰好写了**允许分发安装包的条款 —— 这是「捡到的授权」，不是「默认可行」。
只要换一个免费软件，同样的话术就可能是违规。**每收一条 freeware，都必须回到官方条款读一遍再定性。**

---

## 1. `xnviewmp` — XnViewMP

| 项 | 内容 |
|---|---|
| 官方页 | <https://www.xnview.com/en/xnview-mp/>（下载页，**未直接公布 EULA 全文**） |
| 条款载体 | **随安装包发布**的 `End-User License Agreement`，`Last updated: 2019-07-01`，`Copyright (C) 1997-2019 Pierre-e Gougelet` |
| 条款全文获取 | 官方下载页只有下载按钮；EULA 文本见官方安装包内 `legal/LICENSE.txt`。本次取证通过 **Flathub 官方打包仓库**转引的同一份 EULA 全文（<https://raw.githubusercontent.com/flathub/com.xnview.XnViewMP/master/xnview-license.txt>） |
| ⚠️ 取证局限 | **非从 xnview.com 域名直接读到**。已交叉比对 Chocolatey 包内 `legal\LICENSE.txt` 与 Flathub 版本，两处**逐字一致**（含 2019-07-01 日期与版权行）→ 可判定为同源原文。若需要一手留档，**建议后续从官方 dmg 内提取一份存 `out/`**。 |

### 摘录原文要点（verbatim）

> **1. License**
> SOFTWARE is provided as freeware for private (non commercial), or educational use, including non-profit organization. **Company must purchase licenses to be able to use SOFTWARE.**
> …
> * Commercial license — You are considered as a commercial user if you are: using SOFTWARE at your place of business or for commercial purposes

> **3. Distribution**
> * **Freeware**
>   **You are hereby licensed to make as many copies of the SOFTWARE as you wish and distribute it to anyone provided that all files are intact. You must distribute the install form of the SOFTWARE (not the files resulting of an installation).**

> **Restrictions**
> You may not modify, reverse engineer, decompile, disassemble the SOFTWARE except to the extent you may be expressly permitted by copyright holders.
> **You may not distribute, rent, sub-license the SOFTWARE, except as expressly permitted in this License** without prior written consent from Author.

### 判定：✅ 授予再分发权（附条件）

- 第 3 节 `Distribution → Freeware` 是**明确的再分发授权**：可任意复制并分发给任何人。
- 限制条款里那句「不得再分发」后面跟着 **`except as expressly permitted in this License`** —— 指的就是第 3 节这条许可，**不矛盾**。
- 三个硬条件必须同时满足：
  1. **文件完整**（`all files are intact`）→ 不得删减、不得改包、不得重新打包；
  2. **必须是安装形态**（`the install form … not the files resulting of an installation`）→ 分发原始 `dmg` / `exe` / `zip`，**不能分发安装后的应用目录**；
  3. **非商业使用**（`Company must purchase licenses`）→ 商用需向 XnSoft 购授权。
- 对我们的口径：公众号**免费分享、不收费、不带商业推广性质**，落在「private / educational / non-profit」范围 → 可用。
  ⚠️ 但**一旦公众号转为商业运营**（接商业广告、售卖、企业推广），这条授权立即失效 —— 届时必须下架或购授权。**这是一条需要长期盯的触发条件。**

### 随包与文章要求

- 随包放：官方原版 `dmg`（完整）+ 本 EULA 原文 + 项目官方链接。
- 文章授权区块须写明：**「个人/教育用途免费；商业用途需向官方购买授权」**，不得笼统写「免费可商用」。
- 红线：不得写「破解」「去限制」「无限制版」等词；不得分发安装后的目录形态。

---

## 2. `mp3tag` — Mp3tag

| 项 | 内容 |
|---|---|
| 官方条款页 | <https://hilfe.mp3tag.de/license/>（Mp3tag Documentation · License Information） |
| 版权行 | `Mp3tag Copyright ©1999-2026 Florian Heidenreich` |
| 官方下载 | <https://www.mp3tag.de>（须为官方站点的**自解压安装包**） |

### 摘录原文要点（verbatim）

> **Mp3tag** is designed for private use and commercial use **without sale** ("Freeware"), if the following rules are respected:
> The author, Florian Heidenreich has no responsibility if errors occurs in direct or indirect relation with the software.
> **Mp3tag cannot be used in a military domain or in a similar domain (Weapon creation, armament, etc.).**
> **Mp3tag can be distributed through non-commercial channels, if the delivery happens in the form of the self-extracting setup file available from <https://www.mp3tag.de>.**
> Mp3tag can be distributed through commercial channels if the author, Florian Heidenreich, agrees this delivery and if the delivery happens in the form of the self-extracting setup file available from <https://www.mp3tag.de>.

### 判定：✅ 授予再分发权（非商业渠道 + 限定交付形式）

- 官方**明确允许非商业渠道分发**，条件是交付形式必须是**官方站点的自解压安装包**（self-extracting setup file）。
- 三条限制：
  1. **不得销售**（`without sale`）→ 不可收费、不可捆绑售卖；
  2. **不得用于军事领域**（Weapon creation / armament 等）→ 需在随包说明与文章里声明；
  3. 商业渠道分发需**作者书面同意** → 我们按非商业渠道走，不适用。

### ⚠️ 重大发现：**macOS 版不可分发**

- 官方 License 页只覆盖**免费发行的那一版**；而 Mp3tag 的 **macOS 版本是 Mac App Store 上的付费应用（US$24.99）**，属 App Store 授权体系，**不适用上述 freeware 分发条款**。
- 现状核对：`manifest.json` 里 `mp3tag` 的 `url` 为空、`note` 写着「待核实：download.mp3tag.de 的 macOS 包真实地址与最新版本号」—— 这条**本来就查不到 macOS 直链**，原因就在这里：**它没有免费直链**。
- **处置建议（P1，交 W1/人工决策）**，三选一：
  - **A（推荐）**：把 `mp3tag` 移出「可打包」池 → 降级为「只介绍、不代存」，文章引导读者去官网自行下载（Windows 版可给官方直链）。
  - **B**：只收 **Windows 版**并在 `manifest` 里显式标注 `platform: Windows`，文章写清「macOS 用户请走 App Store 付费版」。
  - **C**：直接从候选池删除。
- 本文档默认按 **A** 记入台账；未擅自改动 `manifest.json`（归 W1），但已在 `night-goal.md` 进度日志里挂为待办。

---

## 3. `mediainfo` / `mediainfo-gui` — MediaInfo（CLI + GUI）

| 项 | 内容 |
|---|---|
| 官方许可页 | <https://mediaarea.net/MediaInfo/License>（标题为 `MediaInfo(Lib) License`） |
| 官方主页声明 | <https://mediaarea.net/MediaInfo>：*"It is Open-Source software which means that end users and developers have freedom to study, to improve and **to redistribute the program** ([BSD-style license])."* |
| 版权主体 | `MediaArea.net SARL`，`Copyright (c) 2002-2026` |

### 摘录原文要点（verbatim）

> Redistribution and use in source and binary forms, with or without modification, **are permitted** provided that the following conditions are met:
> - Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" …

> **Alternate license for redistributions of the library in binary form:**
> Redistributions in binary form must reproduce the following sentence (including the link to the website) in the documentation and/or other materials provided with the distribution:
> *This product uses [MediaInfo](https://mediaarea.net/en/MediaInfo) library, Copyright (c) 2002-2026 [MediaArea.net SARL](mailto:info@mediaarea.net).*

### 判定：✅ 授予再分发权（BSD-2-Clause，源码与二进制形式均可）

- 这是标准的 **BSD 2-Clause**：允许以源码或二进制形式再分发，**允许修改**（但我们不修改）。
- **唯一义务**：在随包文档/材料中**保留版权声明 + 免责声明全文**。二进制再分发可另选「替代条款」——即加一句带链接的声明（`This product uses MediaInfo library…`）。**两种做法都做，最稳。**
- 官方主页的表述（`freedom to … redistribute the program`）覆盖**程序本体（含 GUI）**，不止库。

### ⚠️ 两个必须写进文章的附注

1. **GUI 依赖 Qt（授权叠加）**
   官方许可页明确列了第三方库：**GUI (optional): Qt**（以及 wxWidgets）。Qt 自身是 LGPL/GPL/商业三选授权。
   - 我们分发的是**官方未修改的 dmg**，Qt 及其许可证**随包同行**，义务本身已满足；
   - ⚠️ **但如果将来要自行重新打包/裁剪**（例如只取 CLI），就**必须**逐项复核 Qt 的义务（LGPL 动态链接要求、许可证文本携带等）。原文注明 `GUI (optional)`，说明 CLI 版不依赖 Qt——**要瘦身就优先分发 CLI 版**。
2. **登记版本已过期（交 W1/W3）**
   `manifest.json` 里两条的下载 URL 指向 `26.05`；官方站当前为 **26.10**。
   且 macOS 下载路径形态为 `mediaarea.net/download/binary/mediainfo-gui/<版本>/MediaInfo_GUI_<版本>_Mac.dmg` —— 版本段要随发布更新。**建议纳入版本巡检（`gh:watch`）或写一个最小版本检查。**

### 随包与文章要求

- 随包放：官方原版 `dmg` + BSD-2-Clause 全文 + 那句 `This product uses MediaInfo…` 声明（放 `本包说明.txt` 里即可）。
- 文章授权区块写「BSD-2-Clause 开源协议，允许再分发；保留版权声明与免责声明」。

---

## 4. `runjs` — RunJS

| 项 | 内容 |
|---|---|
| 官方站 | <https://runjs.app/> · 运营主体 **Haas Labs Ltd**（英国） |
| 使用条款 | <https://runjs.app/terms>（`Terms of Service`，`Last updated: January 2nd, 2025`） |
| 开源项目页 | <https://github.com/lukehaas/RunJS> —— **当前仅存 `docs/` `translations/` `CHANGELOG.md` `FOSS_Notices.md` `README.md`**，**没有源码、没有 LICENSE** |
| 商业模式 | 站上标 `Free download`，但正版需**授权 key**（另有 `runjs.app/open-source` 给开源贡献者发免费 license）；第三方讨论区提到免费版有**每日运行次数上限** |

### 摘录原文要点

官方 ToS 全文为通用网站条款，**逐条读过，没有任何一条涉及软件的复制、转存或再分发授权**；核心是免责、责任限制、准据法（英国法）：

> **2. Disclaimer** — The materials on Haas Labs Ltd's website are provided on an 'as is' basis. Haas Labs Ltd makes no warranties…
> **3. Limitations** — In no event shall Haas Labs Ltd or its suppliers be liable for any damages…
> **7. Governing Law** — …governed by and construed in accordance with the laws of United Kingdom…

GitHub 仓库现状：**源码已撤下**，`FOSS_Notices.md` 只列其内嵌的第三方开源组件（Babel / Electron / asar / lodash 等），**属于「本产品内含的 FOSS 清单」，不是 RunJS 本身的授权**。

### 判定：❌ **未授予再分发权** —— 不收录进「可打包」池

- **没有任何授权来源**支持我们转存安装包：
  - 官方 ToS → 无再分发条款；
  - 仓库 → 无 LICENSE、无源码（当前版本是**闭源商业软件**）；
  - 官网 → 只提供「Free download」入口，正版能力靠授权 key 解锁。
- ⚠️ **一个诱人的陷阱**：SourceForge 的 `runjs.mirror` 项目页把 License 标为 **MIT**，`libhunt` 另标 **MPL-2.0** —— 这两处**指的都是旧版（lukehaas 开源时期的 RunJS）**，与现行 runjs.app 商业版**不是同一份授权**。**不要据此认为可分发。**
- 处置：
  - **从「可打包」池移除**；`manifest.json` 里该条的 `url` 保持为空（现状已是空，无需改动）。
  - 若仍想在公众号介绍，**只能做「介绍 + 官方下载引导」**：文章里给 <https://runjs.app/> 让读者自行下载，**不代存、不转存网盘、不给关键词回复链接**。
  - 若确有介绍价值，可考虑改为介绍**开源替代品**（如 JS 运行沙箱类开源工具），但那属于 W1 选品范畴，不在本文档处理。

---

## 5. 汇总裁决表

| id | 授权类型 | 再分发 | 硬条件 | 随包必须带 | 文章必须写 | 动作 |
|---|---|---|---|---|---|---|
| `xnviewmp` | 专有 freeware EULA (2019-07-01) | ✅ | 非商业 · 文件完整 · 安装形态 | EULA 原文 + 官方原版 dmg | 「个人/教育免费，商用需购授权」 | 保留（盯商业转型触发条件） |
| `mp3tag` | 专有 freeware | ✅（仅免费发行版） | 非商业渠道 · 官方自解压安装包 · 非军事用途 | 许可页文本 + 官方安装包 | 「不得销售 / 不得军事用途」 | ⚠️ **macOS 版不可分发 → 建议降级为只介绍** |
| `mediainfo` | BSD-2-Clause | ✅ | 保留版权与免责声明 | LICENSE 全文 + `This product uses MediaInfo…` | 「BSD-2-Clause，允许再分发」 | 保留（顺带更新版本号 26.05→26.10） |
| `mediainfo-gui` | BSD-2-Clause | ✅ | 同上 + Qt 随包同行 | 同上 | 同上（+ 提 Qt 依赖） | 保留（同上） |
| `runjs` | 专有商业（Haas Labs Ltd） | ❌ | — | — | — | **移出可打包池** |

**统计：4 条可分发（3 种授权口径各异）· 1 条不可分发。**

---

## 6. 本轮取证清单（可复核）

| 页面 | URL | 结果 |
|---|---|---|
| Mp3tag License | `https://hilfe.mp3tag.de/license/` | ✅ 官方页直读，全文 |
| MediaInfo License | `https://mediaarea.net/MediaInfo/License` | ✅ 官方页直读，全文 |
| MediaInfo 主页（授权声明） | `https://mediaarea.net/MediaInfo` | ✅ 官方页直读（含「freedom to redistribute」原句） |
| XnView MP 下载页 | `https://www.xnview.com/en/xnview-mp/` | ✅ 直读，但**页上无 EULA 全文**（只有价格与下载） |
| XnView EULA 全文 | `https://raw.githubusercontent.com/flathub/com.xnview.XnViewMP/master/xnview-license.txt` | ✅ 转引（与 Chocolatey 包内 `legal\LICENSE.txt` 逐字一致） |
| RunJS ToS | `https://runjs.app/terms` | ✅ 官方页直读，全文；**无再分发条款** |
| RunJS 官网 | `https://runjs.app/` | ✅ 直读（Free download / 授权 key 模式） |
| RunJS 仓库 | `https://github.com/lukehaas/RunJS` | ✅ 直读；**无 LICENSE、无源码** |

**未能获取 / 存疑项（如实标注，不做推测）**

1. **XnView 的一手 EULA**：xnview.com 域名下未找到 EULA 发布页 → 目前依据安装包内附文本的转引，已交叉印证两处一致。**建议后续从官方 dmg 内提取原文存 `out/` 固化留档。**
2. **Mp3tag macOS 的官方分发条款**：官方 License 页未单独说明 macOS（App Store）版 → 只能确认「免费发行的那一版可分发」，**macOS 版按 App Store 授权处理，不视为可用**。
3. **RunJS 免费版的具体限制条款**（如每日运行次数上限）**未在官方 ToS 中读到**，仅见于第三方讨论 → 不作结论，也**与再分发判定无关**。

---

## 7. 对运营方案的三条回流建议

> **状态更新（2026-10-09 W4 第 2 轮复核）**
> 1. ✅ **已采纳** —— `manifest.json` 已落 `redistributable` 字段：`mp3tag`/`runjs` = `no`、`xnviewmp` = `conditional`、`mediainfo`/`mediainfo-gui` = `yes`（W1 实现）。
> 2. ⏳ 待 W2 在 freeware 文章里落实（文章模板的 freeware 变体已定稿，见《合规与下架流程》§2.3）。
> 3. ✅ **已落地** —— 《合规与下架流程》新增 **§3.4「分发类 / 介绍类：两类条目，两套动作」**，明确介绍类**不给关键词回复链接、不建网盘目录**；关键词配置表（W3）已按 `redistributable` 分档，`mp3tag`/`runjs` 标注「只介绍不给链接」。

1. **`manifest.json` 建议加一个 `redistributable` 字段**（`yes` / `no` / `conditional`）—— 目前「协议」和「能否代存」是两件事，freeware 尤其混。本文档已把 5 条的取值列出，交 W1 决定是否落字段。
2. **freeware 条目文章模板要有独立变体**：不能套用开源项目的「授权声明区块」。必须显式写出**使用范围限制**（商用需购授权 / 不得销售 / 不得军事用途），否则属于**虚假授权陈述**，比没写更危险。
3. **`runjs` 与 `mp3tag(macOS)` 撤下后，「只介绍不代存」需要一条明确的操作规范** —— 建议在《合规与下架流程》里把「介绍类条目」与「分发类条目」分开，介绍类的文章**不给关键词回复链接**，只给官网地址。

### 7.1 仍在盯的两件事（第 2 轮复核未闭环）

| # | 事项 | 为什么还没闭环 | 处置 |
|---|---|---|---|
| 1 | **XnView EULA 一手原文未落档** | xnview.com 域下确实没有 EULA 发布页；当前依据是安装包内附文本的两处转引（Flathub + Chocolatey，逐字一致） | 待下载官方 dmg 后，从包内提取 EULA 原文存 `out/` 固化（**不做任何推测性补写**） |
| 2 | **`mediainfo` / `mediainfo-gui` 的下载 URL 仍是 26.05** | 官方站已到 **26.10**；属 `manifest.json` 的 `url` 字段更新（归 W1） | W4 只挂号；两条目 `redistributable=yes`，版本更新不影响再分发判定 |
| 3 | ⚠️ **XnViewMP 的免费授权以「非商业」为前提** | 公众号一旦商业化（接广告 / 售卖 / 企业推广），该授权**立即失效**，须下架 | 已进月度复查清单（《合规与下架流程》§7）；`redistributable: conditional` 即该含义 |
