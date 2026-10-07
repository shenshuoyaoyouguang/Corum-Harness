/**
 * corum-desktop/host/project-root — 项目根的路径包含守卫。
 *
 * ## 为什么存在（不是新抽象，是补完一次半途迁移）
 *
 * 「根包含不变式」（见 CONTEXT.md）此前在文件面手抄 11 处：9 个 corumFs 端点、
 * bridge 的 /corumfs 媒体路由、以及 revertWrites 的 revertOne。归一化原语早已
 * 被抽到 `@corum/corum-agent/win32-path-helpers`，但那次迁移只走到 2/11（list 与
 * 媒体路由——恰好是当初在 win32 上炸掉的那条读路径），此后端点各自内联，其中
 * 3 处漏掉 realpath 二次校验（mkdir / write 新文件 / rename 目标），可经根内
 * 链接写到根外。本模块把这条不变式收回一处：11 处现场只声明自己的策略。
 *
 * ## 未迁者（已知的第 3 类消费者）
 *
 * `revertOne`（corum-fs.ts）仍自持。它需要「根是参数 + 根再钳制在 host cwd 内 +
 * 目标允许绝对路径 + 三档缺失容忍」，这四个变异各只有一个消费者；按「一个
 * adapter = 假设的 seam」的口径，现在收进来只会让接口长出只有一处使用的选项。
 * 等出现第二个消费者再统一。
 *
 * ## 用法
 *
 * 客户端路径一律按「相对项目根」解析。返回的两个值各有消费者——`target` 是
 * 未解析的落点（新建类操作 write/mkdir/rename 目标用它），`real` 是 realpath 后
 * 的实名（读取、判定、撤销类操作用它），目标不存在时为 `null`（此时已上溯校验过
 * 最近存在的祖先，故「写新文件经链接出根」仍被拒）。
 *
 * @module corum-desktop/host/project-root
 */

import { realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { isRootPath, stripLeadingSep } from '@corum/corum-agent/win32-path-helpers'

/** 逃逸成因。词法与链接成因不同，分列便于判定与呈现。 */
export type RootEscapeReason = 'lexical' | 'symlink' | 'ancestor'

/** 根包含不变式被违反。`reason` 供调用方区分呈现（如 bridge 的 403、端点的话术）。 */
export class ProjectRootEscapeError extends Error {
  readonly reason: RootEscapeReason

  constructor(reason: RootEscapeReason, requested: string) {
    super(reason === 'lexical'
      ? `path escapes the project root: ${requested}`
      : `path escapes the project root via symlink: ${requested}`)
    this.name = 'ProjectRootEscapeError'
    this.reason = reason
  }
}

/**
 * 根拒绝：目标就是项目根本身，而该操作不允许作用于根。
 * 它属操作语义，与「路径能不能用」正交——故与逃逸分属两个类型。
 */
export class ProjectRootDeniedError extends Error {
  constructor(requested: string) {
    super(`refusing to operate on the project root: ${requested}`)
    this.name = 'ProjectRootDeniedError'
  }
}

/** 端点只需声明自己的策略；路径合法性判定一律由本模块做。 */
export interface ResolveInsideRootOptions {
  /** 连「根本身」也拒绝（`remove` 与 `renamePath` 的源侧为 true，其余为 false）。 */
  denyRoot?: boolean
}

/** 落点：`target` 未解析、`real` 已解析（不存在则 null）。 */
export interface InsideRoot {
  target: string
  real: string | null
}

/** 落点在根内？根本身算在根内。 */
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}

/**
 * 把客户端给的路径解析为项目根内的落点，并校验它（含符号链接）没有逃出根。
 *
 * @param root - 项目根（可为泳道工作区）。内部 realpath 一次以消除「未解析的根
 *   vs 已解析的文件」前缀不一致——macOS `/tmp` → `/private/tmp` 即此坑；realpath
 *   失败（根尚不存在）时退回 `resolve`。
 * @param requested - 客户端路径：相对根，`'/'` 或 `''` 表示根。
 * @param options - `denyRoot` 同时拒绝根本身。
 * @returns `{ target, real }`——见模块头注释的消费者说明。
 * @throws ProjectRootEscapeError | ProjectRootDeniedError
 */
export async function resolveInsideRoot(
  root: string,
  requested: string,
  options: ResolveInsideRootOptions = {},
): Promise<InsideRoot> {
  const base = await realpath(resolve(root)).catch(() => resolve(root))
  const normalized = isRootPath(requested) || requested === '' ? '.' : stripLeadingSep(requested)
  const target = resolve(base, normalized)

  // 词法校验：resolve 之后仍在根外（含绝对路径覆盖根的情形）。
  if (options.denyRoot === true && target === base) throw new ProjectRootDeniedError(requested)
  if (!inside(base, target)) throw new ProjectRootEscapeError('lexical', requested)

  // 链接校验：目标存在则直接 realpath；不存在则上溯最近存在的祖先——新建类操作
  // （write 新文件 / mkdir 多层 / rename 目标）同样不得经链接出根。
  const real = await realpath(target).catch(() => null)
  if (real !== null) {
    if (options.denyRoot === true && real === base) throw new ProjectRootDeniedError(requested)
    if (!inside(base, real)) throw new ProjectRootEscapeError('symlink', requested)
    return { target, real }
  }

  const anchor = await nearestExistingAncestor(dirname(target), base)
  if (anchor !== null && !inside(base, anchor)) {
    throw new ProjectRootEscapeError('ancestor', requested)
  }
  return { target, real: null }
}

/**
 * 从 `start` 向上找第一个能 realpath 的祖先，到 `base` 或文件系统根为止。
 * 找不到（连 base 都不在磁盘上）返回 null——此时没有可穿越的链接，放行。
 */
async function nearestExistingAncestor(start: string, base: string): Promise<string | null> {
  let current = start
  for (;;) {
    const real = await realpath(current).catch(() => null)
    if (real !== null) return real
    if (current === base) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
