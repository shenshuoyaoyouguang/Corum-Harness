@echo off
REM corum-desktop Windows dev launcher 入口：委托给 dev.ps1。
REM 会话/设置/profile 持久在 .corum-dev-home（CORUM_HOME 可覆盖），跨重启保留上下文。
REM 与 scripts/dev.sh 同语义的 Windows 等价实现（CMD 入口）。
REM
REM 用法（参数透传给 lib/cli.js）：
REM   dev.cmd                 REM 默认：纯壳 combo 启动器页（IDE 等 combo 从启动器进入）
REM   dev.cmd --combo=coding  REM 直接进指定 combo（如 IDE = coding）
REM   dev.cmd --smoke         REM 无头握手验证
REM
REM 环境覆盖：CORUM_HOME（隔离 home）、CORUM_DEV_HMR（HMR 端口）、CORUM_DEBUG_PORT（CDP 端口）等。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*