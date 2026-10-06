<#
.SYNOPSIS
  corum-desktop Windows dev launcher：稳定 dev home + HMR。
.DESCRIPTION
  会话/设置/profile 持久在 .corum-dev-home（CORUM_HOME 可覆盖），跨重启保留上下文。
  与 scripts/dev.sh 同语义的 Windows 等价实现（PowerShell 版）。
.PARAMETER ForwardArgs
  透传给 lib/cli.js 的命令行参数（由 ValueFromRemainingArguments 收集）。
.EXAMPLE
  powershell -File scripts\dev.ps1
  # 默认：纯壳 combo 启动器页（IDE 等 combo 从启动器进入）
.EXAMPLE
  powershell -File scripts\dev.ps1 --combo=coding
  # 直接进指定 combo（如 IDE = coding）
.EXAMPLE
  powershell -File scripts\dev.ps1 --smoke
  # 无头握手验证
.NOTES
  环境覆盖：CORUM_HOME（隔离 home）、CORUM_DEV_HMR（HMR 端口）、CORUM_DEBUG_PORT（CDP 端口）等。
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ForwardArgs
)

# 切到 desktop 包根目录（脚本在 scripts/ 下，父目录即包根）
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Split-Path -Parent $scriptDir
Set-Location -LiteralPath $packageRoot

# patch vendored Electron.app 的 Info.plist 加中文 localization（macOS 专有）。
# win32 上脚本自带平台守卫会 no-op；外部命令失败不中断脚本（对应 dev.sh 的 `|| true`）。
& node scripts/patch-electron-locales.mjs

# 设置环境变量（尊重已有值，对应 dev.sh 的 ${VAR:-default} 语义）
if (-not $env:CORUM_HOME) {
    $env:CORUM_HOME = Join-Path $packageRoot '.corum-dev-home'
}
if (-not $env:CORUM_DEV_HMR) {
    $env:CORUM_DEV_HMR = '500'
}

# 启动桌面应用开发态，透传命令行参数给 lib/cli.js
if ($ForwardArgs) {
    & node lib/cli.js @ForwardArgs
} else {
    & node lib/cli.js
}