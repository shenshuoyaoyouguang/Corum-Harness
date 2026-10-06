/**
 * win32 路径处理共享辅助 —— 盘符 / UNC 判定与归一原语。
 *
 * ## 为什么独立成文件
 *
 * Windows 适配前，本仓的路径判定散落多处且口径不一（`=== '/'` 判根、
 * `replace(/^\/+/, '')` 剥前导、`startsWith('/')` 判绝对路径），win32 盘符路径
 * 与 UNC 路径一律漏判。本模块集中 6 个**纯计算**原语，供 P0/P1 多处复用
 * （会话目录编码、隔离写门禁、工作区身份归一、文件面路径归一），避免重复
 * 正则与口径漂移。
 *
 * ## 设计约束
 *
 * - **纯函数**：无 I/O、不读 `process.platform`、不抛异常。
 * - **幂等**：`normalizeDriveLetter` 与 `stripDrivePrefix` 重复应用结果不变。
 * - **防御**：空串与非字符串输入安全返回（判定函数返回 `false`，转换函数返回原值）。
 * - **不误判 POSIX**：`/home/user` 不被判为盘符路径；单 `/` 不被判为 UNC。
 *
 * @module @corum/corum-agent/win32-path-helpers
 */

/**
 * 盘符路径判定：匹配 `^[A-Za-z]:[\\/]` 形态。
 *
 * 形如 `D:\`、`C:/`、`D:\work\foo`、`c:/users/bar`。纯盘符 `D:`（无分隔符）
 * **不**判为盘符路径——它不是合法的绝对路径，`mkdir` 也建不出。
 *
 * @param p - 待判定路径。
 * @returns `true` 当且仅当 `p` 以「字母 + 冒号 + 反斜杠或正斜杠」开头。
 */
export function isWindowsDrivePath(p: string): boolean {
  if (typeof p !== 'string') return false
  return /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * UNC 路径判定：匹配 `^[/\\]{2}` 形态。
 *
 * 形如 `\\server\share`、`//server/share`、`/\server`、`\/server`（双分隔符开头，
 * 分隔符可混写）。单 `/` 或单 `\` **不**判为 UNC。
 *
 * @param p - 待判定路径。
 * @returns `true` 当且仅当 `p` 以两个 `/` 或 `\`（可混写）开头。
 */
export function isUncPath(p: string): boolean {
  if (typeof p !== 'string') return false
  return /^[/\\]{2}/.test(p)
}

/**
 * win32 绝对路径判定：盘符路径或 UNC 路径。
 *
 * @param p - 待判定路径。
 * @returns `true` 当且仅当 `p` 是盘符路径或 UNC 路径。
 */
export function isWindowsAbsolutePath(p: string): boolean {
  return isWindowsDrivePath(p) || isUncPath(p)
}

/**
 * 盘符统一大写：`d:\work` → `D:\work`（仅首字母大写，其余不变）。
 *
 * - 非盘符开头（含 POSIX 路径、UNC 路径、空串）原样返回。
 * - 幂等：`normalizeDriveLetter(normalizeDriveLetter(p)) === normalizeDriveLetter(p)`。
 *
 * @param p - 待归一路径。
 * @returns 盘符首字母大写后的路径；非盘符开头则原样返回。
 */
export function normalizeDriveLetter(p: string): string {
  if (typeof p !== 'string') return p
  const match = /^([A-Za-z]):/.exec(p)
  if (match === null) return p
  return match[1].toUpperCase() + p.slice(1)
}

/**
 * 剥盘符前缀：`D:\work\foo` → `\work\foo`（剥 `^[A-Za-z]:`）。
 *
 * - 仅剥开头的「字母 + 冒号」，保留其后内容（含分隔符）。
 * - 非盘符开头（含 POSIX 路径、UNC 路径、空串）原样返回。
 * - 幂等：剥一次后再剥仍不变（结果不以盘符开头）。
 *
 * @param p - 待剥前缀路径。
 * @returns 剥去盘符前缀后的路径；非盘符开头则原样返回。
 */
export function stripDrivePrefix(p: string): string {
  if (typeof p !== 'string') return p
  return p.replace(/^[A-Za-z]:/, '')
}

/**
 * win32 根判定：`D:\`、`C:/` 判为根。
 *
 * 精确匹配「字母 + 冒号 + 单个分隔符」三字符形态，其后不得有内容。
 * `D:\work`（有内容）、`D:`（无分隔符）、`D:\\`（多分隔符）均**不**判为根。
 *
 * @param p - 待判定路径。
 * @returns `true` 当且仅当 `p` 恰为「字母 + 冒号 + 单分隔符」。
 */
export function isWindowsRoot(p: string): boolean {
  if (typeof p !== 'string') return false
  return /^[A-Za-z]:[\\/]$/.test(p)
}
// ── 平台分派入口（读 process.platform）──────────────────────────────────
// 上面 6 个是「win32 形态判定原语」（纯计算、不读 process.platform）；
// 下面 2 个是「平台分派入口」，按当前进程平台分派到对应原语或 POSIX 语义。
// 供文件面路径归一（corum-fs / bridge 等）复用，消除多处 `=== '/'` 判根与
// `replace(/^\/+/, '')` 剥前导的重复正则。口径参考 session-archive.ts:54
// （逐字符分隔符归一）与 terminal-card.ts:283,297（UNC/盘符正例）。

/**
 * 平台分派的根判定。
 *
 * - win32 走 `isWindowsRoot(p)`：`D:\`、`C:/` 判为根。
 * - POSIX 走 `p === '/'`。
 *
 * 与前 6 个纯函数不同，本函数读 `process.platform` 做平台分派。
 *
 * @param p - 待判定路径。
 * @returns 当前平台下 `p` 是否为文件系统根。
 */
export function isRootPath(p: string): boolean {
  if (process.platform === 'win32') return isWindowsRoot(p)
  return p === '/'
}

/**
 * 平台分派的前导分隔符剥离。
 *
 * - win32 **不剥**盘符前导 `\`：保留盘符路径完整性（`D:\work\foo` 原样返回），
 *   后续 `path.resolve(root, 'D:\\work\\foo')` 会正确识别为绝对路径，由调用方
 *   的根逃逸校验（`target.startsWith(root + sep)`）兜底。
 * - POSIX 走 `replace(/^\/+/, '')`：剥前导 `/`，杜绝 `resolve(root, '/abs')`
 *   被绝对路径覆盖 root 的逃逸。
 *
 * 与前 6 个纯函数不同，本函数读 `process.platform` 做平台分派。
 *
 * @param p - 待剥前导路径。
 * @returns 当前平台下剥去前导分隔符后的路径。
 */
export function stripLeadingSep(p: string): string {
  if (typeof p !== 'string') return p
  if (process.platform === 'win32') return p
  return p.replace(/^\/+/, '')
}