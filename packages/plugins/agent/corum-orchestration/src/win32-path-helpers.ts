/**
 * fork（corum）：win32 路径判定辅助 —— 隔离写门禁专用内部副本。
 *
 * ## 为什么在本包内另有一份（而不是 import corum-agent 的 win32-path-helpers）
 *
 * 依赖方向：`corum-agent` **依赖** `corum-orchestration`（反向不成立，见
 * `corum-agent/package.json` 的 `@corum/corum-orchestration` 依赖项与 AGENTS.md
 * 红线）。本包不能反向 import `corum-agent` 的模块 ⇒ 在依赖方向约束下，本包需要
 * 自己持有一份同口径的判定原语。
 *
 * ## 与 `corum-agent/src/win32-path-helpers.ts` 的关系
 *
 * 两份**正则口径完全一致**（`^[A-Za-z]:[\\/]` 盘符、`^[/\\]{2}` UNC），由
 * `docs/windows-adapter-plan.md` 的「单一正则口径」纪律约束。未来若把共享辅助
 * 提取到 `corum-git-core`（两者的共同依赖）可合并为一份；本轮不改动任务 1 的
 * 产出位置，故在此保留内部副本。
 *
 * ## 设计约束
 *
 * - **纯函数**：无 I/O、不读 `process.platform`、不抛异常。
 * - **防御**：非字符串输入安全返回 `false`。
 * - **不误判 POSIX**：`/home/user` 不被判为盘符路径；单 `/` 不被判为 UNC。
 *
 * @module @corum/corum-orchestration/win32-path-helpers
 */

/**
 * 盘符路径判定：匹配 `^[A-Za-z]:[\\/]` 形态。
 *
 * 形如 `D:\`、`C:/`、`D:\work\foo`、`c:/users/bar`。纯盘符 `D:`（无分隔符）
 * **不**判为盘符路径——它不是合法的绝对路径。
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
 * 形如 `\\server\share`、`//server/share`（双分隔符开头，分隔符可混写）。
 * 单 `/` 或单 `\` **不**判为 UNC。
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