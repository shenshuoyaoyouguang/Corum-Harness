/**
 * corum-desktop electron-builder 平台分派入口。
 *
 * 按 process.platform 分派 electron-builder target：
 * - macOS（darwin）：`--mac --arm64`（既有行为不变）
 * - Windows（win32）：`--win --x64`（NSIS 安装包，配置见 package.json build.win）
 *
 * 取代原硬编码 `electron-builder --mac --arm64`，让 `pack:app` 在任意平台
 * 产出对应安装包。macOS 上行为与适配前完全一致。
 *
 * 用法：node scripts/pack-app.mjs
 * @module corum-desktop/scripts/pack-app
 */

import { spawn } from 'node:child_process'

const isWin32 = process.platform === 'win32'
const targetArgs = isWin32 ? ['--win', '--x64'] : ['--mac', '--arm64']
const label = isWin32 ? 'win-x64 (NSIS)' : 'mac-arm64 (dmg+zip)'

console.log(`[pack-app] electron-builder target: ${label}`)

const child = spawn('electron-builder', targetArgs, {
  stdio: 'inherit',
  shell: true,
})
child.on('error', (error) => {
  console.error(`[pack-app] failed to spawn electron-builder: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code) => {
  process.exit(code ?? 1)
})