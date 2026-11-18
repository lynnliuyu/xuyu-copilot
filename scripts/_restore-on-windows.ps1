# 在 Windows 上从迁移包恢复工作副本（macOS 的 restore.sh 在 Windows 上跑不了，这是等价物）。
#
# 用法（在 PowerShell 里，不一定要管理员）：
#   # ① 预演：只打印要做什么，不动任何文件
#   powershell -ExecutionPolicy Bypass -File restore.ps1 -Bundle "D:\bdpan-goofish-migrate-20261019-1516.tar.gz.enc"
#
#   # ② 确认无误后执行（当前所在目录会展开成项目根）
#   cd C:\Users\你\WorkBuddy; mkdir 百度网盘mcp; cd 百度网盘mcp
#   powershell -ExecutionPolicy Bypass -File restore.ps1 -Bundle "D:\...enc" -Apply
#
# -Bundle 可以直接给 .enc（脚本自己校验 + 解密 + 解包），也可以给已解开的迁移包目录。
# 全程 UTF-8：不会把含中文的 .mjs/.py 改成乱码（PowerShell 的 Set-Content 默认 UTF-16，是个坑）。

param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [switch]$Apply,
  [switch]$ForceConfig,
  [string]$Target = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$HOME_DIR = $env:USERPROFILE
$S = $null
$failed = 0
$tempRoot = $null

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Step {
  param([string]$Label, [scriptblock]$Action)
  Write-Host ("  {0,-48}" -f $Label) -NoNewline
  if (-not $Apply) { Say '（预演，未执行）' 'DarkGray'; return $true }
  try { & $Action; Say '✅' 'Green'; return $true }
  catch { Say ("❌ " + $_.Exception.Message) 'Red'; $script:failed++; return $false }
}

function Find-OpenSsl {
  $cands = @(
    "$env:ProgramFiles\Git\usr\bin\openssl.exe",
    "$env:ProgramFiles\Git\mingw64\bin\openssl.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command openssl.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "找不到 openssl.exe。装 Git for Windows 即可（它自带 openssl）：winget install Git.Git"
}

function Resolve-BundleDir {
  param([string]$path)
  if (Test-Path $path -PathType Container) { return (Resolve-Path $path).Path }
  if (-not (Test-Path $path)) { throw "找不到：$path" }

  # ── 校验 sha256 ──
  $shaFile = "$path.sha256"
  if (Test-Path $shaFile) {
    $expected = ((Get-Content $shaFile -Raw) -split '\s+')[0].ToLower()
    Say "  校验 SHA-256…" 'Gray'
    $actual = (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "校验失败：包可能损坏或被改动。期望 $expected，实际 $actual" }
    Say "  ✅ SHA-256 一致" 'Green'
  } else {
    Say "  ⚠ 没有 .sha256 文件，跳过完整性校验" 'Yellow'
  }

  # ── 解密（密码只进环境变量，不落在命令行里）──
  $ss = Read-Host "请输入解密密码（24 位，打包时显示的）" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
  try { $env:MIGRATE_PASS = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

  $script:tempRoot = Join-Path $env:TEMP ("bdpan-migrate-" + (Get-Date -Format 'yyyyMMddHHmmss'))
  New-Item -ItemType Directory -Path $script:tempRoot -Force | Out-Null
  $tar = Join-Path $script:tempRoot 'bundle.tar.gz'

  Say "  解密中…" 'Gray'
  $openssl = Find-OpenSsl
  & $openssl enc -d -aes-256-cbc -pbkdf2 -in $path -out $tar -pass 'env:MIGRATE_PASS'
  if ($LASTEXITCODE -ne 0) { throw "解密失败（密码错？）。openssl 退出码 $LASTEXITCODE" }
  $env:MIGRATE_PASS = $null

  Say "  解包中…" 'Gray'
  & tar -xzf $tar -C $script:tempRoot
  if ($LASTEXITCODE -ne 0) { throw "解包失败（Windows 自带 tar 应可用；否则装 7-Zip 或 Git for Windows）" }
  Remove-Item $tar -Force

  $dir = Get-ChildItem $script:tempRoot -Directory | Select-Object -First 1
  if (-not $dir) { throw "解包后没有找到迁移包目录" }
  return $dir.FullName
}

# ── 开跑 ────────────────────────────────────────────────────
Say "═══ Windows 恢复 ═══" 'Cyan'
Say "迁移包：$Bundle"
Say "目标目录：$Target"
Say ("模式：" + $(if ($Apply) { '✅ 执行（会写文件）' } else { '🔍 预演（加 -Apply 才真做）' }))
Write-Host ""

try {
  $S = Resolve-BundleDir $Bundle
} catch {
  Say ("❌ " + $_.Exception.Message) 'Red'
  exit 1
}
$SEC = Join-Path $S '03-secrets'
Say "  迁移包目录：$S" 'DarkGray'
Write-Host ""

# preflight
foreach ($need in @('01-code.tar.gz', '03-secrets')) {
  if (-not (Test-Path (Join-Path $S $need))) { Say "❌ 迁移包不完整，缺 $need" 'Red'; exit 1 }
}
if (-not (Test-Path (Join-Path $SEC '.env'))) { Say "❌ 缺 03-secrets\.env（没有它网关和发布都跑不起来）" 'Red'; exit 1 }

if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }
if (-not $Apply) { Say "（预演不解压代码，只检查包内容；加 -Apply 才真写目标目录）" 'DarkGray' }

# ① 代码
Say "① 解出代码与草稿" 'White'
Step "01-code.tar.gz → $Target" { & tar -xzf (Join-Path $S '01-code.tar.gz') -C $Target; if ($LASTEXITCODE -ne 0) { throw "tar 失败" } }
$outScripts = Join-Path $S '01b-out-scripts.tar.gz'
if (Test-Path $outScripts) {
  $outDir = Join-Path $Target 'out'
  if ($Apply) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  Step "01b-out-scripts.tar.gz → out\" { & tar -xzf $outScripts -C $outDir; if ($LASTEXITCODE -ne 0) { throw "tar 失败" } }
}

# ② 运行时状态
Say "② 放回密钥与运行时状态" 'White'
Step ".env" { Copy-Item (Join-Path $SEC '.env') (Join-Path $Target '.env') -Force }
if (Test-Path (Join-Path $SEC '.tokens.json')) {
  Step ".tokens.json" { Copy-Item (Join-Path $SEC '.tokens.json') (Join-Path $Target '.tokens.json') -Force }
}
foreach ($f in @('.listings.json', '.excluded.json')) {
  $src = Join-Path $SEC "drafts\$f"
  if (Test-Path $src) {
    $dst = Join-Path $Target "drafts\$f"
    Step "drafts\$f" { if ($Apply) { New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null }; Copy-Item $src $dst -Force }
  }
}
$outSecretDir = Join-Path $SEC 'out'
if (Test-Path $outSecretDir) {
  foreach ($f in Get-ChildItem $outSecretDir -Filter *.json) {
    $dst = Join-Path $Target "out\$($f.Name)"
    Step "out\$($f.Name)" { if ($Apply) { New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null }; Copy-Item $f.FullName $dst -Force }
  }
}

# ③ SSH（连生产机 134）
Say "③ SSH（连黑豹X2 <SERVER_IP>）" 'White'
$sshDir = Join-Path $HOME_DIR '.ssh'
if ($Apply -and -not (Test-Path $sshDir)) { New-Item -ItemType Directory -Path $sshDir -Force | Out-Null }

$keySrc = Join-Path $SEC 'ssh\xgj-134_ed25519'
if (Test-Path $keySrc) {
  $keyDst = Join-Path $sshDir 'xgj-134_ed25519'
  Step "xgj-134_ed25519 → %USERPROFILE%\.ssh" { Copy-Item $keySrc $keyDst -Force }
  # Windows OpenSSH 会拒绝「别人也能读」的私钥 → 关掉继承，只给当前用户只读
  Step "收窄私钥权限（icacls）" {
    & icacls $keyDst /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 失败" }
  }
  $pubSrc = Join-Path $SEC 'ssh\xgj-134_ed25519.pub'
  if (Test-Path $pubSrc) { Step "xgj-134_ed25519.pub" { Copy-Item $pubSrc $sshDir -Force } }
}

$cfgSrc = Join-Path $SEC 'ssh\config'
$cfgDst = Join-Path $sshDir 'config'
if (Test-Path $cfgSrc) {
  if ((Test-Path $cfgDst) -and (-not $ForceConfig)) {
    Say "  ⚠ %USERPROFILE%\.ssh\config 已存在，不覆盖。请手工把下面这段合并进去：" 'Yellow'
    Say "     ---------------- 追加到 $cfgDst ----------------" 'Yellow'
    Get-Content $cfgSrc | ForEach-Object { Say "     $_" 'Yellow' }
    Say "     ------------------------------------------------" 'Yellow'
    Say "     （或用 -ForceConfig 强制覆盖）" 'Yellow'
  } else {
    Step "~\.ssh\config" { Copy-Item $cfgSrc $cfgDst -Force }
  }
}

# ④ .env 里指向 pem 的绝对路径（中继机密钥）
$keySec = Join-Path $SEC 'keys'
if (Test-Path $keySec) {
  Say "④ 中继机私钥（.env 的 MEDIA_SSH_KEY / TUNNEL_SSH_KEY）" 'White'
  $pems = Get-ChildItem $keySec -Filter *.pem
  foreach ($p in $pems) {
    $dst = Join-Path $sshDir $p.Name
    Step "$($p.Name) → %USERPROFILE%\.ssh" { Copy-Item $p.FullName $dst -Force }
    Step "收窄 $($p.Name) 权限" { & icacls $dst /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null }
  }
  if ($Apply -and @($pems).Count -gt 0) {
    # 把 .env 里失效的 macOS 路径改成本机路径（否则 media:netdisk 会报找不到私钥）
    $envPath = Join-Path $Target '.env'
    $lines = Get-Content $envPath
    $new = foreach ($line in $lines) {
      if ($line -match '^(MEDIA_SSH_KEY|TUNNEL_SSH_KEY)=(.+)$') {
        $name = Split-Path $matches[2] -Leaf
        if (Test-Path (Join-Path $sshDir $name)) {
          "$($matches[1])=$sshDir\$name".Replace('\', '/')
        } else { $line }
      } else { $line }
    }
    # UTF-8 无 BOM 写回：Set-Content 在 PS5.1 会写成 UTF-16，含中文的 .env 会坏
    [IO.File]::WriteAllLines($envPath, $new, (New-Object Text.UTF8Encoding $false))
    Say "  ✅ .env 里 pem 路径已指向 $sshDir" 'Green'
  }
}

# ⑤ 百度网盘 CLI 凭据
Say "⑤ 百度网盘 CLI 凭据" 'White'
$bdSrc = Join-Path $SEC 'bdpan'
if (Test-Path $bdSrc) {
  $bdDst = Join-Path $HOME_DIR '.config\bdpan'
  if ($Apply) { New-Item -ItemType Directory -Path $bdDst -Force | Out-Null }
  foreach ($f in Get-ChildItem $bdSrc -Force) {
    $dst = Join-Path $bdDst $f.Name
    Step ".config\bdpan\$($f.Name)" { Copy-Item $f.FullName $dst -Force }
  }
}

# ⑥ 依赖
Say "⑥ 装依赖（npm ci，按 lock 文件锁版本）" 'White'
if ($Apply) {
  Push-Location $Target
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { Say "  ❌ npm ci 失败（先看是不是没装 Node 22）" 'Red'; $failed++ }
  } finally { Pop-Location }
} else {
  Say "  （将执行：cd $Target; npm ci）" 'DarkGray'
}

if ($tempRoot -and (Test-Path $tempRoot)) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ""
if ($failed -gt 0) { Say "═══ 有 $failed 步失败，别急着用，先看上面 ❌ ═══" 'Red' }
else { Say ("═══ " + $(if ($Apply) { '恢复完成' } else { '预演结束' }) + " ═══") 'Cyan' }

@"

接下来必须你亲手做的（脚本替不了）：
  1) 项目路径改写（脚本里还写着 macOS 的家目录）
       cd $Target
       node scripts\_retarget-paths.mjs --to "C:/Users/$env:USERNAME"          # 先预演
       node scripts\_retarget-paths.mjs --to "C:/Users/$env:USERNAME" --apply  # 再执行
  2) 端口转发（替代 macOS 的 launchd）
       powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1 -InstallTask
  3) 百度网盘 CLI 装 Windows 版（包里的 bin\bdpan 是 macOS 的 Mach-O，不能用）
       见 docs\迁移到Windows.md 第 6 节
  4) 跑验证清单：docs\迁移到Windows.md 第 8 节

"@ | Write-Host
