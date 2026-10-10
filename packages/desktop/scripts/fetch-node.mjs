/**
 * corum-desktop 打包脚本（阶段 2：物化 Node 运行时）。
 *
 * 宿主子进程需要真 Node（Electron 内嵌 Node 无法 boot 宿主树），
 * 打包时把它作为 extraResources 打进 .app 的 Resources/node。
 *
 * 来源：从 nodejs.org 官方源（或 NODE_MIRROR 覆盖的镜像）下载
 *   node-v{ver}-{platform}-{arch} 归档并解压。
 *   - darwin → .tar.gz，用 `tar -xzf` 解压，`mv` 重命名
 *   - win32  → .zip，用 fflate（已有依赖）解压，`fs.rename` 重命名
 *
 * 用法：node packages/desktop/scripts/fetch-node.mjs [node-version] [--platform=<p>] [--arch=<a>] [--help]
 *   node-version  目标 Node 版本（如 v26.4.0），缺省取 DEFAULT_VERSION
 *   --platform    目标平台：darwin（默认）| win32
 *   --arch        目标架构：arm64（默认）| x64
 *   --help / -h   打印用法后退出
 * 环境变量：
 *   NODE_MIRROR   node 下载镜像根（如 https://registry.npmmirror.com/-/binary/node）
 *   PLATFORM      目标平台（被 --platform 覆盖）
 *   ARCH          目标架构（被 --arch 覆盖）
 * 向后兼容：不传任何参数时默认走 darwin/arm64 + .tar.gz + tar -xzf + mv。
 * @module corum-desktop/scripts/fetch-node
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..', '..', '..')
/** desktop 包根（脚本位置推导——2026-09 重命名后 packages/shell 已不存在）。 */
const DESKTOP_ROOT = resolve(import.meta.dirname, '..')
const NODE_DIR = join(DESKTOP_ROOT, 'build', 'node')

const DEFAULT_VERSION = 'v26.4.0'
/**
 * 默认平台/架构跟随当前进程（`process.platform` / `process.arch`），
 * 与上游打包链一致：不传参数时按运行机物化对应平台/架构的 Node 运行时。
 */
const DEFAULT_PLATFORM = process.platform
const DEFAULT_ARCH = process.arch

/**
 * 解析 CLI 参数与环境变量，确定目标平台/架构/版本。
 *
 * 优先级：CLI 参数 > 环境变量 > 默认值（process.platform / process.arch）。
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ platform: string, arch: string, version: string | undefined, help: boolean }}
 */
function parseArgs(argv) {
  const result = {
    platform: process.env.PLATFORM ?? DEFAULT_PLATFORM,
    arch: process.env.ARCH ?? DEFAULT_ARCH,
    version: undefined,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      result.help = true
    } else if (arg.startsWith('--platform=')) {
      result.platform = arg.slice('--platform='.length)
    } else if (arg.startsWith('--arch=')) {
      result.arch = arg.slice('--arch='.length)
    } else if (!arg.startsWith('--') && result.version === undefined) {
      // 第一个非选项参数视为 node 版本（保持原 argv[2] 语义）
      result.version = arg
    }
  }
  return result
}

/**
 * 按目标平台分派归档格式与解压/重命名策略。
 *
 * - darwin → .tar.gz，`tar -xzf` 解压，`mv` 重命名（保持既有行为）
 * - win32  → .zip，fflate 解压，`fs.rename` 重命名（不依赖 POSIX mv）
 * @param {string} platform
 * @returns {{ ext: string, useTar: boolean, useMv: boolean }}
 */
function platformConfig(platform) {
  if (platform === 'win32') {
    return { ext: '.zip', useTar: false, useMv: false }
  }
  // darwin 及其他 POSIX 平台保持默认（向后兼容）
  return { ext: '.tar.gz', useTar: true, useMv: true }
}

const USAGE = `Usage: node packages/desktop/scripts/fetch-node.mjs [node-version] [options]

Options:
  [node-version]   目标 Node 版本（如 v26.4.0），缺省取 ${DEFAULT_VERSION}
  --platform=<p>   目标平台：win32 | darwin（默认按 process.platform）
  --arch=<a>       目标架构：x64 | arm64（默认按 process.platform）
  --help, -h       打印本用法后退出

Environment:
  NODE_MIRROR      node 下载镜像根（如 https://registry.npmmirror.com/-/binary/node）
  PLATFORM         目标平台（被 --platform 覆盖）
  ARCH             目标架构（被 --arch 覆盖）

默认（不传参数）：按 process.platform 选 win32/x64 或 darwin/arm64（向后兼容）`

async function run(label, command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${label} exited ${code}`))))
  })
}

/**
 * 用 fflate（desktop 已有依赖，纯 JS）解压 .zip 到目标目录。
 *
 * win32 上不依赖外部 `unzip`/`tar`，避免 GNU tar 不支持 zip、
 * 以及老版 Windows 缺 bsdtar 的环境差异。zip 内部路径以 `/` 分隔，
 * 逐条目创建目录并写入文件字节。
 * @param {string} zipPath - .zip 文件绝对路径
 * @param {string} destDir - 解压目标目录（须已存在）
 */
async function extractZip(zipPath, destDir) {
  const { unzipSync } = await import('fflate')
  const buf = await readFile(zipPath)
  const entries = unzipSync(new Uint8Array(buf))
  const destRoot = resolve(destDir)
  for (const [relPath, bytes] of Object.entries(entries)) {
    const target = resolve(destDir, relPath)
    // zip-slip 防护：拒绝逃逸 destDir 的条目（如 ../scripts/pack-app.mjs）
    if (target !== destRoot && !target.startsWith(destRoot + sep)) {
      throw new Error(`fetch-node: zip entry escapes destDir (${relPath}) — refusing to extract`)
    }
    if (relPath.endsWith('/')) {
      // 目录条目
      await mkdir(target, { recursive: true })
    } else {
      // 文件条目：先确保父目录存在再写入
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
  }
}


async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  const version = args.version ?? DEFAULT_VERSION
  const platform = args.platform
  const arch = args.arch
  const { ext, useTar, useMv } = platformConfig(platform)

  await rm(NODE_DIR, { recursive: true, force: true })
  await mkdir(join(DESKTOP_ROOT, 'build'), { recursive: true })

  // Node.js 官方归档命名：win32 平台用 `win`（如 node-v26.4.0-win-x64.zip），不是 `win32`
  const archivePlatform = platform === 'win32' ? 'win' : platform
  const name = `node-${version}-${archivePlatform}-${arch}`
  const mirror = (process.env.NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/$/, '')
  const url = `${mirror}/${version}/${name}${ext}`
  const archivePath = join(DESKTOP_ROOT, 'build', `${name}${ext}`)

  if (!existsSync(archivePath)) {
    console.log(`[fetch-node] downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch-node: HTTP ${response.status} for ${url}`)
    await pipeline(response.body, createWriteStream(archivePath))
  } else {
    console.log(`[fetch-node] using cached ${archivePath}`)
  }

  const buildDir = join(DESKTOP_ROOT, 'build')
  const extractedDir = join(buildDir, name)

  if (useTar) {
    // darwin / POSIX：tar -xzf 解压
    await run('extract node', 'tar', ['-xzf', archivePath, '-C', buildDir])
  } else {
    // win32：fflate 解压 .zip（不依赖外部 tar/unzip）
    console.log(`[fetch-node] extracting ${archivePath} via fflate`)
    await extractZip(archivePath, buildDir)
  }

  if (useMv) {
    // darwin / POSIX：mv 重命名
    await run('rename node dir', 'mv', [extractedDir, NODE_DIR])
  } else {
    // win32：fs.rename 重命名（不依赖外部 mv）。win32 zip 把 node.exe 放在归档根，
    // .cmd 启动器（npm.cmd 等）用 `%~dp0\node.exe` 解析 bundled node —— 保持归档原样
    // 不移动，hostNode() 直接从 `Resources/node/node.exe` 找（见 main.ts hostNode）。
    await rename(extractedDir, NODE_DIR)
  }
  console.log('[fetch-node] node runtime staged at', NODE_DIR)
}

await main().catch((error) => {
  console.error(error)
  process.exit(1)
})
