/**
 * 旧会话索引读取（**只读**，供迁移使用）。
 *
 * 统一模型（`architecture.project.unified-with-type-field`）之前，两模式各有一套
 * 键空间不同构的索引。本模块把它们**读成统一形态**，交给迁移层合并进
 * `$CORUM_HOME/sessions.json`（见 session-index.ts）。本模块**只读不写**：
 * 旧文件在迁移后保留为迁移前残影（不删——回滚安全网）。
 *
 * ## 两套旧形态
 *
 * **① task 侧**：`$CORUM_HOME/projects/task/corum/task-sessions.json`
 * 键 = `sessionId`，值 = `{cwd, profileId}` ⇒ 已是统一形态的键空间，
 * 唯一缺的是 `type`（恒 `task`）。
 *
 * **② project 侧**：`$CORUM_HOME/projects/<id>/corum/sessions.json`
 * 键 = `"<profileId><laneKey>"`（如 `devgeneral`、`pmgeneral`），
 * 值 = `sessionId` ⇒ **必须用 projectId 才能反查出 cwd**（值里没有 cwd）。
 * 故本模块需按索引目录反查 project.json 拿 cwd。
 *
 * ⚠️ **`<profileId><laneKey>` 是拼接键，理论上不可逆拆分**（profileId 与 laneKey
 * 都允许连字符/字母，无分隔符）。实测存量键形如 `pmgeneral` / `devui` /
 * `devreq-<uuid>:ui`（需求段带 `:` 分隔符）。因此本模块**不猜拆键**：
 * 改成**正向枚举**——用索引条目里的 projectId 查项目组，拿真实 profileId 列表去
 * 匹配键前缀；匹配不上时**整键当 laneKey、profileId 标记为空**由迁移层决定
 * （宁可让迁移层看见异常，也不静默编造一个错的 profileId）。
 *
 * @module @corum/corum-agent/legacy-index
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { corumHome } from './session-index.ts'
import type { SessionIndexEntry } from './session-index.ts'
// 工作区身份（L0 助手）：项目模式剥离后由 workspace-identity.ts 承接。
import { canonicalWorkspaceKey, isValidProjectId } from './workspace-identity.ts'

/** 一条从旧索引读出的会话（统一形态 + 来源标记）。 */
export interface LegacySession {
  sessionId: string
  entry: SessionIndexEntry
  /** 来源形态（诊断/报告用）。 */
  origin: 'task-index' | 'project-index'
  /** project 侧来源时的 projectId（task 侧为 undefined）。 */
  projectId?: string
}

/** 旧 task 伪项目 id（`$CORUM_HOME/projects/task/`）。 */
export const LEGACY_TASK_PROJECT_ID = 'task'

/** 旧 task 索引文件路径。 */
export function legacyTaskIndexPath(home: string = corumHome()): string {
  return join(home, 'projects', LEGACY_TASK_PROJECT_ID, 'corum', 'task-sessions.json')
}

/** 旧 project 索引文件路径。 */
export function legacyProjectIndexPath(projectId: string, home: string = corumHome()): string {
  return join(home, 'projects', projectId, 'corum', 'sessions.json')
}

/** 读 JSON（失败 = undefined；绝不 throw）。 */
function readJsonSafe(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读旧 task 索引（统一形态键空间：`sessionId → {cwd, profileId}`）。
 *
 * 每条补 `type: 'task'`（该索引里的会话按定义都是任务模式创建的）。
 */
export function readLegacyTaskIndex(home: string = corumHome()): LegacySession[] {
  const raw = readJsonSafe(legacyTaskIndexPath(home))
  if (raw === null || typeof raw !== 'object') return []
  const out: LegacySession[] = []
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const cwd = typeof v.cwd === 'string' ? v.cwd : undefined
    const profileId = typeof v.profileId === 'string' ? v.profileId : undefined
    // cwd 缺失的条目无法归入任何工作区（统一模型下身份由 cwd 决定）⇒ 丢弃。
    if (cwd === undefined || cwd === '' || profileId === undefined || profileId === '') continue
    out.push({
      sessionId,
      entry: { cwd, profileId, type: 'task' },
      origin: 'task-index',
    })
  }
  return out
}

/**
 * 读旧 project 索引（`"<profileId><laneKey>" → sessionId`）。
 *
 * profileId 用**正向枚举**拆：拿该项目的项目组成员 profileId 逐个试前缀匹配
 * （长的先试，避免 `dev` 抢先匹配 `dev-lead`）；都不匹配则 profileId 留空、
 * 整键作 laneKey（迁移层据此判断「这条需要人工/规则裁定」）。
 *
 * @param projectId - 项目 id（用于反查 cwd 与项目组）。
 * @param home - CORUM_HOME。
 */
export function readLegacyProjectIndex(projectId: string, home: string = corumHome()): LegacySession[] {
  const raw = readJsonSafe(legacyProjectIndexPath(projectId, home))
  if (raw === null || typeof raw !== 'object') return []
  const cwd = readLegacyProjectCwd(projectId, home)
  if (cwd === undefined) return [] // cwd 失联/索引缺失 ⇒ 无法定身份，交由迁移层按「死条目」处理
  const knownProfiles = readProjectMemberProfileIds(projectId, cwd)
  const out: LegacySession[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') continue
    // 优先从 sessionId 反解（可信度最高）：project 泳道的 sessionId 形如
    // `corum-proj<projectId>-agent<profileId>-lane<laneKey>-<rand>`
    // （agent-service.ts:1016 的构造式，`lane` 段在更早版本里叫 `type`）。
    // 反解不出才退回拆复合键（见 splitCompositeKey 的保守策略）。
    const parsed = parseProjectSessionId(value, projectId)
    const split = parsed === undefined ? splitCompositeKey(key, knownProfiles) : undefined
    const profileId = parsed?.profileId ?? split?.profileId ?? ''
    const laneKey = parsed?.laneKey ?? split?.laneKey ?? ''
    out.push({
      sessionId: value,
      entry: {
        cwd,
        profileId,
        type: 'project',
        ...(laneKey !== '' ? { laneKey } : {}),
      },
      origin: 'project-index',
      projectId,
    })
  }
  return out
}

/**
 * 从 project 泳道的 sessionId 反解 projectId / profileId / laneKey。
 *
 * 构造式（`agent-service.ts:1016`）：
 *   `corum-proj<projectId>-agent<profileId>-lane<slugLaneKey>-<8位随机hex>`
 * 更早版本的第二段分隔词是 `type` 而非 `lane`（存量实测：
 * `corum-projproject-agentpm-typegeneral-2bc71598`），两种都认。
 *
 * **为什么优先用它**：sessionId 是**创建时按真实值直接拼的**，而复合键
 * `<profileId><laneKey>` 是无分隔符拼接、只能猜。前者可信度更高。
 *
 * `projectId` 由调用方给出（来自索引目录名），故不用猜 projectId 边界——这正是
 * 本函数能可靠工作的前提（projectId 可含连字符，独立解析会有歧义）。
 *
 * @returns 解析结果；不形如 project 泳道 / projectId 不匹配 ⇒ undefined。
 */
export function parseProjectSessionId(
  sessionId: string,
  projectId: string,
): { projectId: string; profileId: string; laneKey: string } | undefined {
  const prefix = `corum-proj${projectId}-agent`
  if (!sessionId.startsWith(prefix)) return undefined
  const rest = sessionId.slice(prefix.length)
  // `<profileId>-(lane|type)<laneKey>-<rand>`
  const m = /^(.+?)-(?:lane|type)(.*)-[0-9a-f]+$/.exec(rest)
  if (m === null) return undefined
  const profileId = m[1] ?? ''
  const laneKey = m[2] ?? ''
  if (profileId === '') return undefined
  return { projectId, profileId, laneKey }
}

/**
 * 拆 `"<profileId><laneKey>"` 拼接键。
 *
 * **不靠猜**：用已知 profileId 集合做前缀匹配（长前缀优先）。匹配不上的键
 * **整键当 laneKey**、profileId 留空——这是有意的保守：编造一个错的 profileId
 * 比留空更糟（错的 profileId 会让会话在错误的角色下显示）。
 */
export function splitCompositeKey(
  key: string,
  knownProfiles: readonly string[],
): { profileId: string; laneKey: string } {
  const candidates = [...knownProfiles]
    .filter(p => p !== '' && key.startsWith(p))
    // 长前缀优先：`dev-lead` 必须先于 `dev` 匹配，否则 `dev-leadx` 会被拆成 `dev` + `-leadx`。
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  const hit = candidates[0]
  if (hit === undefined) return { profileId: '', laneKey: key }
  return { profileId: hit, laneKey: key.slice(hit.length) }
}

/** 读项目条目里的 cwd（索引 project.json；读不到返回 undefined）。 */
function readLegacyProjectCwd(projectId: string, home: string): string | undefined {
  const raw = readJsonSafe(join(home, 'projects', projectId, 'project.json'))
  if (raw === null || typeof raw !== 'object') return undefined
  const cwd = (raw as Record<string, unknown>).cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * 读一个项目的成员 profileId 集合（项目侧 ProjectInfo 的 group；兜底索引残留 group）。
 * 读不到时返回空集合 ⇒ 拆键退化为「整键作 laneKey」（保守，不编造）。
 */
function readProjectMemberProfileIds(projectId: string, cwd: string): string[] {
  const fromInfo = readJsonSafe(join(cwd, '.corum', 'project', 'project.json'))
  const infoMembers = membersOf(fromInfo)
  if (infoMembers.length > 0) return infoMembers
  return membersOf(readJsonSafe(join(corumHome(), 'projects', projectId, 'project.json')))
}

/** 从 project.json 形里抽 group.members[].profileId。 */
function membersOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return []
  const group = (raw as Record<string, unknown>).group
  if (group === null || typeof group !== 'object') return []
  const members = (group as Record<string, unknown>).members
  if (!Array.isArray(members)) return []
  return members
    .map(m => (m !== null && typeof m === 'object' ? (m as Record<string, unknown>).profileId : undefined))
    .filter((p): p is string => typeof p === 'string' && p !== '')
}

/** 列出 `$CORUM_HOME/projects/` 下的全部项目 id（含伪 task 目录）。 */
export function listLegacyProjectIds(home: string = corumHome()): string[] {
  const root = join(home, 'projects')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && isValidProjectId(d.name))
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 读全部旧索引（task + 每个 project），合并成统一形态列表。
 *
 * 同一 sessionId 在多来源出现时**保留先读到的**（task 优先：task 索引的
 * `{cwd, profileId}` 是直接记录，project 侧的拼接键是推断出来的，前者更可信）。
 */
export function readLegacyIndexes(home: string = corumHome()): LegacySession[] {
  const byId = new Map<string, LegacySession>()
  for (const s of readLegacyTaskIndex(home)) byId.set(s.sessionId, s)
  for (const projectId of listLegacyProjectIds(home)) {
    if (projectId === LEGACY_TASK_PROJECT_ID) continue // 伪项目目录，已按 task 索引读过
    for (const s of readLegacyProjectIndex(projectId, home)) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, s)
    }
  }
  return [...byId.values()]
}

/** 会话本体所在目录（`$CORUM_HOME/sessions/--<cwd 编码>--/<sessionId>/`）。 */
export function sessionBodyDir(cwd: string, sessionId: string, home: string = corumHome()): string {
  return join(home, 'sessions', encodeCwdForSessionsDir(cwd), sessionId)
}

/**
 * cwd → 会话目录名编码（官方 session-persistence 同款：`--` + 去根斜杠后
 * 分隔符换 `-` + `--`）。
 *
 * 平台分支：
 * - **win32**：保留盘符字母（`D:` → `D-`，不剥盘符），再把 `\` 与 `/`
 *   一并换 `-`。避免目录名含 `:` / `\` 导致 `mkdir` ENOENT——这是会话本体与存量
 *   迁移在 Windows 上整体不可用的根因。**保留盘符**是必须的：剥盘符会让
 *   `C:\work\foo` 与 `D:\work\foo` 编码到同一目录名 `--work-foo--`，不同盘的
 *   同名工作区会共享会话存储（P1）。
 * - **POSIX**：去前导 `/` 后 `/` 换 `-`（原逻辑，保持不变）。
 *
 * 产出恒以 `--` 包围，且不含 `:` / `\` / `/` 等 Windows 非法目录名字符。
 * 过长 key（深层 Windows 工作区路径展平后可能超 255 字符的组件限制）会
 * 被稳定截断为「前缀 + sha1 后缀」，保留区分度且保证 `mkdir` 可建（P2）。
 */
export function encodeCwdForSessionsDir(cwd: string): string {
  const key = canonicalWorkspaceKey(cwd) ?? cwd
  return `--${encodeSessionDirKey(key)}--`
}

/**
 * 会话目录名中段长度上限。
 *
 * Windows 组件名限 255 字符，`--` 包围占 4 字符（见 {@link encodeCwdForSessionsDir}），
 * 留余量取 200——既远低于 255，又给 hash 后缀留足空间。
 */
const SESSION_DIR_KEY_MAX = 200

/**
 * 长 key 截断用的 hash 后缀长度（sha1 hex 前 8 字符，32 bit 区分度）。
 *
 * 截断形为 `<前 191 字符>-<8 字符 hash>`，总长恰为 {@link SESSION_DIR_KEY_MAX}。
 */
const SESSION_DIR_KEY_HASH_LEN = 8

/**
 * 工作目录键 → 会话目录名中段（不含 `--` 包围）。
 *
 * 按平台分派：win32 保留盘符字母（`D:` → `D-`）后双分隔符换 `-`；POSIX 去前导 `/` 后
 * `/` 换 `-`。产出不含 `:` / `\` / `/`，保证 `mkdir` 在任一平台均可建。
 *
 * 过长产出（`> {@link SESSION_DIR_KEY_MAX}`）会被稳定截断为「前缀 + sha1 后缀」：
 * 同一 key 恒截到同一结果（幂等），不同 key 借 hash 后缀保留区分度。
 */
function encodeSessionDirKey(key: string): string {
  let encoded: string
  if (process.platform === 'win32') {
    // 保留盘符字母（`D:\work` → `D-\work`），再把 `\` 与 `/` 一并换 `-`。
    // 不剥盘符：`C:\work\foo` 与 `D:\work\foo` 须编码到不同目录名，否则不同盘的
    // 同名工作区会共享会话存储（P1）。盘符大小写已由 canonicalWorkspaceKey 归一。
    encoded = key.replace(/^([A-Za-z]):/, '$1-').replace(/[\\/]/g, '-')
  } else {
    encoded = key.replace(/^\//, '').replace(/[/]/g, '-')
  }
  // 长 key 截断：深层 Windows 工作区路径展平后可能超 255 字符的组件限制，
  // 导致会话路径无法创建或找到（P2）。取前缀 + 稳定 hash 后缀，保留区分度。
  if (encoded.length > SESSION_DIR_KEY_MAX) {
    const hash = createHash('sha1').update(encoded).digest('hex').slice(0, SESSION_DIR_KEY_HASH_LEN)
    const prefixLen = SESSION_DIR_KEY_MAX - SESSION_DIR_KEY_HASH_LEN - 1 // 留 1 字符给分隔 `-`
    encoded = `${encoded.slice(0, prefixLen)}-${hash}`
  }
  return encoded
}
