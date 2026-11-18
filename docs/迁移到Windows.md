# 换到 Windows 继续开发

> 适用：把开发工作副本从 Mac 搬到 **Windows 10/11**。**线上服务一秒都不会停**（生产在黑豹X2，跟你的电脑无关）。
>
> Mac 版手册见 [迁移到新电脑.md](./迁移到新电脑.md)。

---

## 0. 结论先行

| 部分 | 换 Windows 后 |
|---|---|
| 闲鱼店铺 / 自动发货 / 网关 / 公网入口 | **完全不受影响**，全在黑豹X2 `<SERVER_IP>` 上跑 |
| 代码 + 758 份草稿 + 台账 + 密钥 | 跟着迁移包扎进去，恢复后有 |
| `npm run` 那一套（发布、体检、`draft:*`） | ✅ 原生能用（都是 Node/tsx） |
| 端口转发 8790 / 8787 | ⚠️ 要做替代，用 `scripts\_windows-tunnel.ps1`（Windows 没有 launchd） |
| `~/bin/*.sh`、`launchctl`、`shasum` | ❌ 全部失效，已给出等价命令 |
| 图片体检的 OCR | ⚠️ **会降级**：macOS Vision → tesseract，见第 8 节 |
| 网盘 CLI `bdpan` | ✅ 有 Windows 版，要重装（包里的那个是 Mach-O，跑不了） |

---

## 1. 先选路线：原生 Windows，还是 WSL2

| | 原生 Windows（**推荐**） | WSL2 + Ubuntu |
|---|---|---|
| `npm run ...` | ✅ | ✅ |
| 图片体检 OCR | tesseract | tesseract（一样降级） |
| Chrome 出图 / 打 PDF | ✅ 原生，最省事 | 要去调 Windows 的 chrome.exe，别扭 |
| 网盘 CLI | ✅ 有 Windows 安装包 | ✅ linux 版原本就支持 |
| `~/bin/*.sh` 隧道脚本 | ❌ 要换成 `.ps1` | ✅ 原样能跑 |
| 偶尔要跑的 `.sh` 辅助脚本 | ❌ | ✅ |
| 踩坑数量 | **少** | 多（`/mnt/c` 权限、跨系统换行、文件慢） |

**建议：原生 Windows。** 只有当你以后要大量跑 `.sh` 脚本或本地起 Docker 时，再装 WSL2 兜底 —— 两者可以并存，项目放 `C:\` 下，WSL 通过 `/mnt/c/...` 访问同一份代码。

---

## 2. 装环境（一条条跑，管理员 PowerShell 装完 OpenSSH 后可退回普通窗口）

```powershell
# 基础三件套
winget install OpenJS.NodeJS.22      # Node 22（项目实测 v22.22.2）
winget install Git.Git               # Git + 自带 openssl（解密迁移包要用）
winget install Google.Chrome         # 出商品图、打印中文 PDF

# Python（少数脚本用；3.12 起）
winget install Python.Python.3.12

# SSH 客户端（Win10 1809+ 需手动开启，管理员窗口）
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0

# OCR（上架体检用；winget 里若找不到就用官网安装包）
winget install UB-Mannheim.TesseractOCR
```

装完**新开一个** PowerShell 验证：

```powershell
node -v          # v22.x
npm -v
git --version
python --version # 3.12.x
ssh -V
tesseract --version
```

> ⚠️ `winget` 的包 id 我这里**没法在 Windows 上实测**（我手上是 Mac）。哪条报「找不到包」，就去官网下安装包，别卡住。

**tesseract 必须补中文语言包**，否则只会认英文：

```powershell
# 默认装到 C:\Program Files\Tesseract-OCR
# 把 chi_sim.traineddata 放进 tessdata 目录（GitHub tessdata 仓库可下）
Invoke-WebRequest "https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata" `
  -OutFile "C:\Program Files\Tesseract-OCR\tessdata\chi_sim.traineddata"
tesseract --list-langs     # 要能看到 chi_sim 和 eng
```

---

## 3. 恢复工作副本

### 3.1 目录位置**不要改**

在 Windows 上用和 Mac **完全同名同层级**的路径：

```
C:\Users\<你的用户名>\WorkBuddy\百度网盘mcp
```

为什么：脚本里有 12 处写死了 `/Users/noonebook/WorkBuddy/百度网盘mcp`。保持层级一致，就只是把 `/Users/noonebook` 换成 `C:/Users/<你>` 一件事（一条命令搞定，见 4.1）。换个目录名会让这 12 处全部错位。

### 3.2 两条命令恢复

先把**三个文件放在同一个文件夹**（`restore.ps1` 必须和 `.enc` 同级 —— 它要在解密**之前**就能跑，
所以不能只放在加密包里；同一份也在包内，解完包会有一份）：

```
D:\migrate\
├── bdpan-goofish-migrate-20261019-1542.tar.gz.enc
├── bdpan-goofish-migrate-20261019-1542.tar.gz.enc.sha256
└── restore.ps1
```

```powershell
# ① 建空目录并进去（恢复脚本在「当前目录」展开代码）
mkdir C:\Users\$env:USERNAME\WorkBuddy\百度网盘mcp -Force
cd C:\Users\$env:USERNAME\WorkBuddy\百度网盘mcp

# ② 预演（先看一眼要做什么，不动文件；会问一次解密密码）
powershell -ExecutionPolicy Bypass -File D:\migrate\restore.ps1 `
  -Bundle "D:\migrate\bdpan-goofish-migrate-20261019-1542.tar.gz.enc"

# ③ 确认无误后执行
powershell -ExecutionPolicy Bypass -File D:\migrate\restore.ps1 `
  -Bundle "D:\migrate\bdpan-goofish-migrate-20261019-1542.tar.gz.enc" -Apply
```

`-Bundle` 有两种给法：

| 给什么 | 脚本会做什么 |
|---|---|
| `.enc` 加密包 | 校验 `SHA-256` → 问你要密码 → 解密 → 解包到临时目录 → 再往下走 |
| 已解开的包目录 | 直接往下走 |

脚本会自动：解代码 → 放回 `.env` / 台账 / `.tokens.json` / SSH 私钥 / 中继机 pem / 网盘凭据 → `npm ci`。
**默认预演，`-Apply` 才动文件。** 已存在的 `%USERPROFILE%\.ssh\config` 不会被覆盖，只打印要合并的片段。

> 脚本里解密用的是 **Git 自带的 openssl**（Windows 没有系统 openssl），所以第 2 步的 Git **必须先装**。

---

## 4. 装完必做三件事（不做会静默出错）

### 4.1 改写脚本里的家目录

```powershell
# 先预演：列出 12 个文件、14 处
node scripts\_retarget-paths.mjs --to "C:/Users/$env:USERNAME"

# 确认后执行
node scripts\_retarget-paths.mjs --to "C:/Users/$env:USERNAME" --apply
```

**为什么不用 PowerShell 一行 `Get-Content | Set-Content` 搞定**：PS 5.1 的 `Set-Content` 默认写 **UTF-16LE**，会把含中文的 `.mjs`/`.py` 变成乱码 —— 文件还能打开、命令也不报错，等你发现时已经改完 12 个文件了。这个脚本用 Node 读写，固定 **UTF-8 无 BOM**，且只动 `scripts/` 和 `packages/` 下的代码文件，**不碰** `drafts/`（758 份中文草稿）、`assets/`（二进制）。

### 4.2 收窄私钥权限

Windows 的 OpenSSH **不认 chmod**，靠 ACL 判断。恢复脚本已经自动跑了 `icacls`；如果之后 `ssh` 报 `UNPROTECTED PRIVATE KEY FILE` 或 `bad permissions`，手工补一次：

```powershell
icacls "$env:USERPROFILE\.ssh\xgj-134_ed25519" /inheritance:r /grant:r "$($env:USERNAME):(R)"
icacls "$env:USERPROFILE\.ssh\workbuddykaifa.pem" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

### 4.3 告诉脚本 Chrome 在哪

商品图和中文 PDF 都靠无头 Chrome。两个渲染脚本认 `CHROME_PATH`：

```powershell
[Environment]::SetEnvironmentVariable('CHROME_PATH',
  'C:\Program Files\Google\Chrome\Application\chrome.exe', 'User')
```

（`artcraft-manual.mjs` 已改成「Windows 自动用上面这个路径，也认 `CHROME_PATH`」，不用手改源码。）

---

## 5. 端口转发：替代 launchd

Mac 上这条隧道由 launchd 托管（断了自动重连）。Windows 的等价物是**计划任务程序**，已经包好了：

```powershell
# 注册成「登录时自动启动」，隐藏窗口常驻
powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1 -InstallTask

# 立即启动 / 看状态 / 卸载
Start-ScheduledTask -TaskName fmkj-admin-forward
powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1 -UninstallTask
```

它同时转发两个端口，**别只转一个**：

| 端口 | 谁在用 | 只转一半的后果 |
|---|---|---|
| `8790` | 运营台（浏览器打开 `http://127.0.0.1:8790`） | 打不开运营台 |
| `8787` | `ops-check`（体检）、`check-delivery`（发货自查） | 报「网关不可达」**假告警**，会误导你去查真故障 |

不想常驻就前台跑（关窗口就断）：去掉 `-InstallTask` 直接执行。

---

## 6. 百度网盘 CLI 换成 Windows 版

包里的 `03-secrets\bin\bdpan` 是 **macOS arm64 的 Mach-O**，Windows 上直接跑不了。重装：

```powershell
# 官方安装包（已实测该地址返回 200）
curl.exe -L -o "$env:TEMP\bdpan-installer.exe" `
  "https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/installer/3.7.3/bdpan-installer-windows-amd64.exe"
& "$env:TEMP\bdpan-installer.exe"
```

装完把凭据放到 CLI 认的位置（恢复脚本已经放好）：

```powershell
dir $env:USERPROFILE\.config\bdpan      # 应看到 .token_key / config.json
bdpan whoami
```

⚠️ 官方只对 `linux` / `darwin` 出了安装器逻辑，**Windows 只有这个 `windows-amd64.exe`**，版本号比 Mac 上的 3.8.7 旧（3.7.3）。命令子集基本一致；真遇到某个子命令不支持，就去 134 上跑（生产环境里本来就有 CLI）。

---

## 7. 验证清单（8 项，全过再开工）

在项目根目录的 PowerShell 里跑：

| # | 命令 | 期望 |
|---|---|---|
| 1 | `node -v` | `v22.x` |
| 2 | `npm ci; npx tsc --noEmit` | 无报错 |
| 3 | `ssh xgj134 "hostname; uname -m"` | `armbian` / `aarch64` |
| 4 | `bdpan ls "软件/ArtCraft 开源套件"` | 列出目录（token 生效） |
| 5 | `ssh xgj134 'curl -s -o /dev/null -w "%{http_code}" https://xgj.fmkj.top/goofish/ping'` | **405** |
| 6 | `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8787/goofish/ping` | **405** |
| 7 | `(Get-Content drafts\.listings.json -Raw -Encoding UTF8 \| ConvertFrom-Json).PSObject.Properties.Count` | **755** 左右 |
| 8 | `$w=Get-Content assets\_shared\banned-words.json -Raw -Encoding UTF8 \| ConvertFrom-Json; $w.text.block.Count; $w.text.warn.Count` | **8** 和 **6** |

**第 7、8 项最关键**：一个是业务状态（丢了等于失忆，会重复上架已有商品），一个是安全闸门（丢了体检静默失效，拦不住违禁词）。**两者缺失都不会报错。**

> 第 6 项用 `curl.exe` 而不是 `curl`：PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，而且它遇到 405 会抛异常。`curl.exe` 才是真 curl。

---

## 8. 能力降级：图片体检变弱（必须知道）

| 能力 | macOS | Windows |
|---|---|---|
| 读图里的文字 → 查违禁词 | Vision ✅ | tesseract ✅（但准确率低） |
| 图像分类（~1300 类，识别人像/暴露） | Vision ✅ | **❌ 没有替代** |
| 肤色像素占比兜底 | ✅ | ✅（纯 JS，跟平台无关） |

实测量级：拿 3 张真实商品图对比，**tesseract 在 `block` 层漏判 2 张**（调 `--psm`、放大、灰度都没用）；`GPT` / `ChatGPT` 这类短 token 反而保得住。

**所以**：`GPT` 这类必封词照样能拦，但**「图片里出现过度暴露的女性图」这一层在 Windows 上基本等于没有**。两个应对：

1. 新商品图先手工看一眼（最省事）；
2. 旧的 Mac 留着当「体检机」，专门跑 `PREFLIGHT_OCR=vision npm run preflight`。

容器里（134）的 Linux 也只有 tesseract，跟 Windows 是同一档 —— 这不是迁移造成的退步，是**除了 macOS 谁都没有 Vision**。

---

## 9. 最容易踩的 5 个坑

| 坑 | 症状 | 解法 |
|---|---|---|
| **UTF-16 写文件** | 中文全变 `?`，命令不报错 | 别用 `Set-Content` 改代码；用 `_retarget-paths.mjs`；`Get-Content` 一定带 `-Encoding UTF8` |
| **CRLF 污染脚本** | `.sh` / `.mjs` 报 `\r: command not found`、正则莫名不匹配 | `git config --global core.autocrlf false`（克隆 git bundle 之前设） |
| 私钥权限 | `UNPROTECTED PRIVATE KEY FILE` | 见 4.2 `icacls` |
| `raw.githubusercontent.com` 直连被墙 | 下载超时、HTTP 000 | 项目里所有抓取脚本已改成走 `gh-proxy.com`；手工下也同理 |
| 中文路径 | 少数老工具/脚本报路径不存在 | Node 22、Python 3.12、Git 都支持；真出事就把项目挪到 `C:\dev\bdpan-goofish`，然后重跑 4.1 的路径改写 |

---

## 10. 迁完之后、第一次发布前

1. **节流 300s/条**（服务端护栏，前端按钮绕不过）。别在解封首日猛发，先发 1 条金丝雀，核到 `item_id > 0` 再滴灌。
2. **上架前跑 `npm run preflight`**。`GPT` 是 block 级禁词，**图片里出现也会封**。
3. **判成功只认 `item_id > 0`**。`publish.run` 返回 ok 只是「提交时刻」状态，线上可能还在审核甚至被拒。
4. 换店/换类目必须 `--recreate`；别为了「试试能不能过」反复 `publish.run` —— 每次失败都会给商品**追加**一条 `publish_shop`，把 1 店的商品毒化成 2 店，此后永久报 `code=100001`。

---

## 11. 回滚

旧 Mac 上**什么都别删**，等 Windows 上 8 项验证全过、并成功发过 1 条商品，再清理。

最小可回退集：代码目录 + `drafts/.listings.json` + `.env`（+ 两个 `.ssh` 私钥）。
