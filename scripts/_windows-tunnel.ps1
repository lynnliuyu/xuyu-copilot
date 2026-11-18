# 在 Windows 上保持「本机 127.0.0.1:8790 / 8787 → 黑豹X2(<SERVER_IP>)」的 SSH 端口转发。
#
# 为什么需要它
# ------------
# macOS 上这条隧道由 launchd（com.fmkj.admin-forward）托管，进程挂了自动重连。
# Windows 没有 launchd，等价物是「计划任务程序」，本脚本把两者都包了：
#   · 直接跑        → 前台保活，断了 5 秒重连（关窗口就停）
#   · -InstallTask  → 注册成「登录时启动」的计划任务，隐藏窗口常驻
#   · -UninstallTask→ 删掉计划任务
#   · -Status       → 只看当前端口通不通
#
# 为什么 8790 和 8787 必须一起转
# ------------------------------
# scripts/ 里有 8 处硬编码 127.0.0.1:8790（运营台）和 127.0.0.1:8787（网关）。
# 只转一个，`npm run ops` 会报「网关不可达」、`npm run check:delivery` 直接失败
# —— 都是假告警，但很容易被当成真故障去查。
#
# 用法（在 PowerShell 里，不一定要管理员）：
#   powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\_windows-tunnel.ps1 -InstallTask
#
# ⚠️ 前提：%USERPROFILE%\.ssh\config 里有 xgj134 别名，且私钥权限收窄过（见 docs\迁移到Windows.md）

param(
  [switch]$InstallTask,
  [switch]$UninstallTask,
  [switch]$Status,
  [int]$LocalAdminPort = 8790,
  [int]$LocalGatewayPort = 8787
)

$ErrorActionPreference = 'Stop'
$TaskName = 'fmkj-admin-forward'

function Find-Ssh {
  $candidates = @(
    "$env:SystemRoot\System32\OpenSSH\ssh.exe",
    "$env:ProgramFiles\Git\usr\bin\ssh.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "找不到 ssh.exe。请装 Windows 自带的 OpenSSH 客户端（设置 → 应用 → 可选功能）或 Git for Windows。"
}

function Test-Port([int]$Port) {
  # 判据：能建立 TCP 连接 = 隧道通。注意「端口在监听但连不通」＝远端有残留会话（见项目铁律 #11）
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync('127.0.0.1', $Port).Wait(1500)
    $c.Close()
    return $ok
  } catch { return $false }
}

function Show-Status {
  Write-Host "═══ 隧道状态 ═══"
  foreach ($p in @($LocalAdminPort, $LocalGatewayPort)) {
    $ok = Test-Port $p
    $mark = if ($ok) { '✅ 通' } else { '❌ 不通' }
    Write-Host ("  127.0.0.1:{0}  {1}" -f $p, $mark)
  }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Host ("  计划任务 {0}：{1}" -f $TaskName, $task.State)
  } else {
    Write-Host "  计划任务：未注册"
  }
}

if ($Status) { Show-Status; exit 0 }

if ($UninstallTask) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✅ 已删除计划任务 $TaskName"
  } else {
    Write-Host "计划任务 $TaskName 本来就不存在"
  }
  exit 0
}

if ($InstallTask) {
  $self = $MyInvocation.MyCommand.Path
  $ps = (Get-Command powershell.exe).Source
  $action = New-ScheduledTaskAction -Execute $ps `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $self)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description '把本机 8790/8787 转发到黑豹X2(<SERVER_IP>)' -Force | Out-Null
  Write-Host "✅ 已注册计划任务 $TaskName（登录时自动启动）"
  Write-Host "   立即启动：Start-ScheduledTask -TaskName $TaskName"
  Write-Host "   查看状态：powershell -ExecutionPolicy Bypass -File `"$self`" -Status"
  exit 0
}

# ── 前台保活 ────────────────────────────────────────────────
$ssh = Find-Ssh
$key = Join-Path $env:USERPROFILE '.ssh\xgj-134_ed25519'

if (-not (Test-Path $key)) {
  Write-Host "❌ 找不到私钥：$key" -ForegroundColor Red
  Write-Host "   先从迁移包 03-secrets\ssh\ 拷到 %USERPROFILE%\.ssh\ 下，并收窄权限（见 docs\迁移到Windows.md）。"
  exit 1
}

Write-Host "═══ 隧道保活中（Ctrl+C 停止）═══"
Write-Host "  $ssh"
Write-Host ("  -L {0}:127.0.0.1:{0}  -L {1}:127.0.0.1:{1}  xgj134" -f $LocalAdminPort, $LocalGatewayPort)
Write-Host ""

$attempt = 0
while ($true) {
  $attempt++
  Write-Host ("[{0}] 连接中…（第 {1} 次）" -f (Get-Date -Format 'HH:mm:ss'), $attempt)
  & $ssh -N `
    -o ExitOnForwardFailure=yes `
    -o ServerAliveInterval=30 `
    -o ServerAliveCountMax=3 `
    -o StrictHostKeyChecking=accept-new `
    -o IdentitiesOnly=yes `
    -i $key `
    -L "$($LocalAdminPort):127.0.0.1:$($LocalAdminPort)" `
    -L "$($LocalGatewayPort):127.0.0.1:$($LocalGatewayPort)" `
    xgj134
  $code = $LASTEXITCODE
  Write-Host ("[{0}] ssh 退出（code={1}），5 秒后重连…" -f (Get-Date -Format 'HH:mm:ss'), $code) -ForegroundColor Yellow
  if ($code -ne 0 -and $attempt -ge 3) {
    Write-Host "  连不上先按顺序查：① ssh xgj134 hostname 能不能登 ② 是不是不在同一局域网 ③ 私钥权限" -ForegroundColor Yellow
  }
  Start-Sleep -Seconds 5
}
