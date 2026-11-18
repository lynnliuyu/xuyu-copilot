# 开源软件公众号 · F 级资源核查（第三方组件与内置资源）

> 2026-10-09 · 工作流 W4（合规深挖与法务落地）第 2 轮
> 对象：首批报告里挂了 3 轮未动的两个 F 级条目 —— `bongocat`、`alt-tab`
> 取证方式：GitHub 公开页面内嵌文件树 + `raw` 读许可证正文 + Live2D 官方 EULA 页（**只读，未耗 GitHub API 配额，未做任何对外动作**）
> 原始日志：`out/w4r2-probe-tree.log`、`out/w4r2-lic.log`、`out/w4r2-vendor.log`

---

## 一、结论速查

| id | 项目 | 顶层强信号 | 核查结论 | 对候选池的处置 |
|---|---|---|---|---|
| `bongocat` | BongoCat | `vendor/cubism/5-r.5` | ⛔ **内置 Live2D Cubism **专有** 核心库，再分发条件无法由我们满足** | **移出可打包池**，降级为「只介绍 + 引导去官方仓库/官网下载」 |
| `alt-tab` | AltTab | `vendor` | ✅ **可用**：3 个内置组件全为宽松许可（MIT / MIT / CC BY 4.0），无 NC/ND | **保留可打包**，但随包须补 3 份组件许可证正文 + 1 条字体提示 |

> 两个结论都有一手条款依据，不是推断。下面逐条给证据。

---

## 二、`bongocat` —— 不能打包（Live2D Cubism 专有核心）

### 2.1 目录里到底装了什么

```
ayangweb/BongoCat  (master, ★23,849, 主协议 Apache-2.0)
└── vendor/cubism/5-r.5/
    ├── LICENSE.md        ← 2,667 B，Live2D 的四层许可总说明
    ├── NOTICE.md         ← 4,240 B，SDK 构建注意事项（非授权条款）
    └── Core/            ← ⚠️ 关键：dll/windows/x86_64 + include + lib
resources/
├── icons/
└── models/              ← gamepad / keyboard / standard（Live2D 模型数据）
```

`Core/` 是 **Live2D Cubism Core** —— 它就是被编译进最终 app 的那份原生库，**不是开源的**。

### 2.2 `LICENSE.md` 自己就写明了四层许可（verbatim）

```
## Cubism SDK Release License
*All business* users must obtain a Cubism SDK Release License. "Business" means an entity with
the annual gross revenue more than ten million (10,000,000) JPY for the most recent fiscal year.

## Live2D Open Software License
Live2D Cubism Components is available under Live2D Open Software License.

## Live2D Proprietary Software License
Live2D Cubism Core is available under Live2D Proprietary Software License.

## Free Material License
Live2D models listed below are available under Free Material License.
（Haru / Hiyori / Mao / Mark / Natori / Ren / Rice / Wanko —— 每个模型都须单独同意条款）
```

⭐ **关键区分**：`Cubism Core` → **Proprietary**（专有）；Cubism Components 的其余部分 → Open Software License。BongoCat 打包进 app 的正是 Core。

### 2.3 专有协议里卡住再分发的三条（verbatim，取自官方 EULA 页）

来源：`https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html`（HTTP 200，正文 54,123 字符，本地留档 `/tmp` 已过期，摘录见本节）

> **§1.23　"Redistribute"** means to perform, show, publicly transmit, display or distribute of part or whole duplicate of the Software, and preparation thereof with or without consideration (including the introduction of all or part of the Software into a server for third parties with access via the Internet).

> **§1.24　"Redistributable Code"** means the Object Code form or Source Code form which is indicated in the *"RedistributableFiles.txt"* file included in the Software, indicated in the appendix attached to the Agreement, or specified separately by Live2D to the Customer.

> **§5.1　Right of Use and Redistribution**
> The Customer may copy and distribute the Redistributable Code. In addition, the Customer may allow the **Distributors of Derivative Works and Output Files** to copy and distribute the Redistributable Code **as a part of the Derivative Works and Output Files of the Customer**.

> **§5.2.2** Have the Distributors and End Users of Customer's Derivative Works and Output Files **agree to the provisions for the protection of the Redistributable Code that are equivalent to those hereunder**.

> **§5.2.4** Redistribute the Redistributable Code **on an as is basis** when Live2D provides it.

> **§6.2　No Distribution, Disclosure or Bundling**
> Except as expressly permitted in this Agreement, the Customer **may not distribute or disclose all or part of this Software, or bundle the same** with the Derivative Work.

### 2.4 为什么「我们发个安装包」也过不去

| 问题 | 我们的处境 |
|---|---|
| 我们不是 §1.24 里的 **Customer** | 我们是第三方转存者，**没有与 Live2D 签过任何协议**，谈不上「依 §5.1 被允许分发」 |
| §5.2.2 要求「分发者与最终用户同意等效保护条款」 | 公众号关键词回复发链接的场景里，**无法让匿名下载者同意任何条款** —— 这一条我们**客观上做不到** |
| 仓库里**没有** `RedistributableFiles.txt` | 无法确认 `Core/` 究竟是否属于「可再分发代码」；**存疑即不可分发** |
| §6.2 明文禁止 bundling | 把它跟安装包一起转存分发，正落在「bundling」的字面范围内 |
| 就算走「开源许可」路径 | Open Software License §2.2.3 也要求「接收方**继承**本协议」（the recipient **succeeds to this Agreement**）才允许第三方分发 —— 同上，做不到 |

### 2.5 处置

1. **`bongocat` 不进打包池**，改为**只介绍**：文章可写，但给的是**官方仓库 / 官网下载页**，**不给网盘链接、不配关键词自动回复的直链**（否则等于我们在做转存分发）。
2. 与 `mp3tag` / `runjs` 同档处理（「介绍类」），需在 `manifest.json` 侧标明 —— **该文件归 W1，W4 只挂号**（建议 `redistributable: "no"`）。
3. ⭐ **沉淀成通用规则**（见本文第五节 R1）：**凡内置 Live2D Cubism Core 的项目，一律不进打包池** —— 这条规则的价值大于单个条目，因为 Live2D 系软件（桌宠、虚拟形象、部分壁纸类）在「设计创作」方向里出现频率不低。

---

## 三、`alt-tab` —— 可用，但随包要补 3 份组件许可证

### 3.1 `vendor/` 里装的是三个正常依赖

```
lwouis/alt-tab-macos  (master, ★16,371, 主协议 GPL-3.0 · LICENCE.md)
└── vendor/
    ├── AppCenter/          → UPSTREAM: appcenter-4.3.0 + PLCrashReporter-1.11.1
    │                         SOURCE: https://github.com/microsoft/appcenter-sdk-apple.git
    │                         （Frameworks/CrashReporter.xcframework + Sources + Package.swift）
    ├── ShortcutRecorder/   → UPSTREAM: alt-tab-current@52c6273d233f7794e4fd5d22f50d2de0e4e41b19
    │                         SOURCE: https://github.com/lwouis/ShortcutRecorder.git
    │                         （Sources/ShortcutRecorder，20+ 语言 lproj、SR*.m）
    ├── Sparkle/            → UPSTREAM: VERSION=2.9.1, DATE=2026-05-12
    │                         SOURCE: https://github.com/sparkle-project/Sparkle/releases/download/2.9.1/Sparkle-2.9.1.tar.xz
    └── scripts/            → update_appcenter.sh / update_shortcut_recorder.sh / update_sparkle.sh
```

### 3.2 逐个核到上游（均为宽松许可，无 NC / ND）

| 组件 | 版本（仓库内 `UPSTREAM` 记录） | 上游许可证 | 取证 |
|---|---|---|---|
| **Sparkle** | 2.9.1（2026-05-12） | **MIT** + `EXTERNAL LICENSES` 段（bsdiff = BSD-2、sais-lite = MIT 风格、Ed25519 = zlib 风格、`SUSignatureVerifier.m` = BSD-2）—— **全部宽松** | `raw` 读 `sparkle-project/Sparkle/2.9.1/LICENSE`，6,153 B |
| **App Center SDK** | appcenter-4.3.0 + PLCrashReporter-1.11.1 | **MIT**（"Visual Studio App Center SDK for Apple platforms / Copyright (c) Microsoft Corporation / MIT License"） | `raw` 读 `microsoft/appcenter-sdk-apple/develop/LICENSE`，1,144 B |
| **ShortcutRecorder**（lwouis fork） | `alt-tab-current@52c6273` | **CC BY 4.0**（README 徽章声明；⚠️ 仓库**无 LICENSE 文件**，`raw .../LICENSE` 404） | `raw` 读 fork 的 `README.md` |

> ⚠️ **CC BY 4.0 用在代码上是不规范的**（Creative Commons 自己不建议这样用），但它**允许商用与再分发**，唯一硬性义务是**署名（BY）** → 不属于 D/E 类，**可用**，但署名必须保留。

### 3.3 三个必须写进随包材料的点

1. **`vendor/` 里没有这三份许可证的正文** —— 仓库只放 `UPSTREAM`（版本+来源）记录。
   → 按 MIT / BSD 的义务，分发**必须**携带各自的版权声明与许可证全文。
   → 所以随包材料里要**额外补三份**：`LICENSE-Sparkle.txt`、`LICENSE-AppCenterSDK.txt`、`LICENSE-ShortcutRecorder.txt`（正文从 3.2 的上游地址逐字取）。
2. **`resources/SF-Pro-Text-Regular.otf` 是 Apple 的 SF Pro 字体** ⚠️
   → 它随 app 一起分发是上游的正常做法（macOS 应用内使用），但**我们绝不能把它单独提取出来再分发**（字体文件本身不可再分发）。
   → 随包材料里写明：**安装包原样分发，不得拆包取用内部资源**。
3. **主协议仍是 GPL-3.0** —— 上一轮的 `SOURCE-获取方式.txt` + `LICENSE-原文.txt`（`LICENCE.md`，35,149 B）**一个都不能少**，这与 vendor 组件的宽松许可**并行、不互相替代**。

### 3.4 处置

- **保留 `alt-tab` 在可打包池**（与首批报告的 F 级定性一致：代码可分发，只需把资源核清 —— 现已核清）。
- 随包要求已由 `scripts/make-source-note.mjs` 的 **「三、内置第三方组件」** 段自动写入 `out/source-notes/alt-tab/本包说明.txt`（见第四节实现）。
- ⚠️ 遗留提示：`resources/SF-Pro-Text-Regular.otf` 的存在意味着 **`alt-tab` 的包不做任何「精简/重打包」** —— 只原样转存官方 dmg。这条对**所有** macOS app 通用（很多 app 内含 Apple 字体或系统框架副本）。

---

## 四、工具落地：`make-source-note.mjs` 新增「内置第三方组件」段

- 新增 `VENDOR_NOTES` 表（当前登记 `alt-tab` 一条），生成 `本包说明.txt` 时自动追加组件清单 + 各自许可证 + 随包补件要求。
- 目的：**把这次的核查结论固化进随包文件**，避免「核查过了，但打包的人不知道要补什么」。
- 后续新条目若出现 `vendor` / `fonts` / `models` 强信号，先在本文件给出结论，再往 `VENDOR_NOTES` 里加一条（**核查与落地同一处**）。
- 检查模式 `--check` 会读取同一张表，把「需补组件许可证」列进提示项。

---

## 五、沉淀出的通用规则（比单个条目更重要）

| # | 规则 | 来源 |
|---|---|---|
| **R1** | **内置 Live2D Cubism Core 的项目一律不进打包池** —— Core 是专有库，其再分发以「与 Live2D 签约的 Customer 及其授权 Distributor」为前提，第三方转存无法满足 §5.2.2「让最终用户同意等效条款」 | `bongocat` |
| **R2** | **`vendor/` 存在 ≠ 有问题；`vendor/` 里没附 LICENSE 才是问题** —— 前者要逐个核上游，后者意味着**我们得自己补齐**才能履行 MIT/BSD 的随附义务 | `alt-tab` |
| **R3** | **仓库根许可证不覆盖 `resources/`** —— 字体（SF Pro 等）、Live2D 模型、图标素材各有授权；**判据是「能不能单独再分发该资源」**，不是「app 里能不能用」 | `alt-tab` / `bongocat` |
| **R4** | **Creative Commons 许可出现在代码仓 = 需要看一眼** —— CC BY 可用（署名即可）；CC BY-NC / ND 不可用（Mos 已因此剔除）。**看到 CC 先读全称，别只看 "CC"** | `alt-tab`（CC BY 4.0）、Mos（CC BY-NC，首批已剔除） |
| **R5** | **`UPSTREAM` 文件是好东西** —— 它记录了内置组件的版本与来源，是**版本复查**（月度授权变更检查）的抓手：组件升版可能带许可变化 | `alt-tab` |

---

## 六、挂号（不属 W4 文件，等对方采纳）

| # | 事项 | 归属 |
|---|---|---|
| 1 | `manifest.json` 的 `bongocat` 建议标 `redistributable: "no"`（与 `mp3tag`/`runjs` 同档，只介绍不代存） | **W1** |
| 2 | `alt-tab` 的 `usage` 建议补一句「随包须另附 Sparkle / AppCenter / ShortcutRecorder 三份组件许可证」 | **W1** |
| 3 | 若后续要把组件许可证正文也自动落盘，可考虑给 `make-source-note.mjs` 加 `--vendor-licenses`（从 `VENDOR_NOTES` 的上游地址抓取）——**本轮未做**，因需要联网抓取，且组件正文变动不频繁 | **W4 下轮（可选）** |
| 4 | `gh-audit.mjs` 目前只报**顶层**强信号。`alt-tab` 是顶层 `vendor` 命中、`bongocat` 是 `vendor/cubism/5-r.5` 这种**嵌套目录**命中 —— 若要让体检器提前预警 Live2D 类风险，可加一条特征匹配（`cubism` / `live2d` 目录名或 `Core/`），使 R1 自动化 | **W3** |

---

## 附：本轮取证记录

| 文件 | 内容 |
|---|---|
| `out/w4r2-probe-tree.mjs` / `.log` | 两仓库顶层 + `vendor`/`resources` 子目录树取证（GitHub 页面内嵌 JSON） |
| `out/w4r2-probe-vendor.mjs` / `out/w4r2-vendor.log` | vendor 子目录与资源目录细查（AppCenter / ShortcutRecorder / Sparkle / resources） |
| `out/w4r2-fetch-lic.mjs` / `out/w4r2-lic.log` | Cubism `LICENSE.md`、`NOTICE.md`、BongoCat `LICENSE`/`README.zh-CN`、alt-tab `UPSTREAM` 正文 |
| Live2D 官方 EULA | 专有 / 开源两份协议页（HTTP 200），关键条款 verbatim 摘录见 §2.3、§2.4 |
