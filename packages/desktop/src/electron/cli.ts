/**
 * corum-desktop CLI launcher: spawns Electron with the built main entry. The
 * `electron` package's runtime export is the binary path (its types are the
 * Electron API namespace), so the path is read through createRequire. The
 * shebang is added by the tsdown banner at build time.
 * @module corum-desktop/electron/cli
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string
const main = fileURLToPath(new URL('./main.js', import.meta.url))

/**
 * 纯壳净化：不把 dsh 运行态环境透传给 Electron 主进程。DSH_HOME /
 * CORUM_DESKTOP_* / CORUM_COMBO_* / DSH_* 是 dsh 侧内容，由壳按所选 combo
 * 在 spawn host 子进程时注入（main.ts buildHostEnv + boot.ts 消费），壳自身
 * 不携带。CORUM_HOME 是壳的 home 配置（会话/设置目录），保留供 dev 隔离。
 */
const DSHSANITIZE = [
  'DSH_HOME',
  'DSH_CHECKOUT',
  'DSH_TELEMETRY_DISABLED',
  'CORUM_DESKTOP_MODE',
  'CORUM_DESKTOP_PROFILE',
  'CORUM_COMBO_PLUGINS',
  'CORUM_COMBO_PATCHES',
  // 解释器接管类（2026-10-07 实机踩到）：宿主工具（IDE / AI 终端等）常以
  // `ELECTRON_RUN_AS_NODE=1` 注入其 shell 环境，透传后 Electron 会退化成纯
  // Node —— 应用参数被 node 当作非法选项拒绝（`Corum.exe: bad option:
  // --smoke`，exit 9），且只能在启动期由二进制自身判定，应用代码无法补救。
  // cli 是开发启动入口，此处剥离即让 `corum-desktop` / `corum-desktop
  // --combo=…` 在任何宿主 shell 下都能真正起 Electron。NODE_OPTIONS 刻意
  // 不清（可能是开发者有意注入的 --inspect 调试配置）。
  'ELECTRON_RUN_AS_NODE',
]

// The Electron main only hosts the combo-manager shell; it spawns the host
// bridge child under SYSTEM Node (this process's own binary) and relays IPC
// to it. Pass the node path down so the main never has to guess one.
const env: NodeJS.ProcessEnv = { ...process.env, CORUM_HOST_NODE: process.execPath }
// 大小写不敏感：环境变量名在 Windows 上不区分大小写（Electron 读到的同样不区分），
// 精确匹配删不掉宿主注入的小写键。口径同 combos.ts 的 sanitizeComboEnv。
const sanitize = new Set(DSHSANITIZE)
for (const key of Object.keys(env)) {
  if (sanitize.has(key.toUpperCase())) delete env[key]
}

const child = spawn(electronPath, [main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
