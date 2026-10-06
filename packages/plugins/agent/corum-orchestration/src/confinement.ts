/**
 * fork（corum）：**隔离子会话的写边界**——把「改动只能落在自己的 worktree 里」从
 * 「一句提示词」变成机制。
 *
 * ## 为什么有这个文件（2026-09-22 用户实测，隔离第 2 层被整档旁路）
 *
 * `docs/plan/PLAN-subagent-isolation.md` §1.3 把隔离写成「**四层硬隔离（全部机制，
 * 无 prompt 纪律）**」，其中第 2 层是「fs 写沙箱：以 `session.header.cwd` 为
 * workspace-write 边界」。但沙箱模式是**按档位**开关的：
 *
 * | 层 | `workspace-write` | `danger-full-access` |
 * |---|---|---|
 * | ② fs 写沙箱 | ✅ 生效（子会话 cwd=worktree） | ❌ **整档旁路** |
 * | ③ shell/构建 | ✅ 以 header.cwd 起 | ⚠️ cwd 仍在 worktree，但可自由 `cd` / `git -C` |
 *
 * 而子会话的沙箱模式此前**整体继承父档位**（`captureDelegatedPolicyOverrides` 只
 * 在 `pinReadOnly` 时钉死）⇒ 用户在指挥模式切「完全权限」后，隔离的物理基础当场
 * 消失。实测（会话 `corum-task-ef3f751e`）：同一个 brief 结构，`workspace-write`
 * 派出的 worker 对主树写报 EPERM（硬隔离生效），`danger-full-access` 派出的 worker
 * 则成功删掉 19 个 worktree、并对主树执行 `git -C <主树> merge --no-ff`。
 *
 * ## 两层修法（用户 2026-09-22 拍板 1+2）
 *
 * ① **正交轴**（`corum-subagent` 的 `confinedSandbox`）：隔离期把子会话沙箱钉成
 *    `workspace-write`（**不继承**父档位，与 research 的 `readonlySandbox` 同一手法），
 *    于是第 2 层永远生效。边界 = 子会话 `header.cwd` = worktree。
 * ② **纵深防御**（本文件的 {@link confinementGuard}）：即便沙箱被旁路（未装配 /
 *    平台差异 / 未来改动），也拒绝对 worktree 之外路径的**写形态**调用。
 *
 * ## 为什么本文件在 corum-orchestration（而不是 corum-agent / corum-subagent）
 *
 * 依赖方向：`corum-agent` 与 `corum-subagent` **都**依赖 `corum-orchestration`
 * （反向不成立）。写形态判定（{@link detectBashWrite}）与写工具名单的单一事实源
 * 因此只能是这一层——否则两个消费方各存一份，正是规范禁止的「两处实现」。
 * `corum-agent/permission-policy.ts` 改为从本模块 import 并 re-export（保持其单测
 * 的 import 路径不变）。
 *
 * @module @corum/corum-orchestration/confinement
 */

import path from 'node:path'
import { tmpdir } from 'node:os'
// fork（corum）win32 适配：隔离写门禁的盘符/UNC 路径判定。
// 依赖方向约束：corum-orchestration 不能 import corum-agent 的 win32-path-helpers
// （corum-agent 依赖本包，反向不成立），故用本包内部同口径副本。
import { isWindowsAbsolutePath } from './win32-path-helpers.ts'

/**
 * fork（corum）：**变异工具 → 它的路径参数名**（写边界门禁的判定面）。
 *
 * 与 {@link CORUM_MUTATION_TOOLS}（`orchestration.ts` 的写工具名单）**同源对账**：
 * 名单里每出现一个直接改文件的工具，这里必须能说出它的路径参数；`bash`/`pwsh`
 * 不在此表（它们走 {@link detectBashWrite} 的文本判定）。
 *
 * `str_replace_editor` 的路径参数是 `path`（官方 tool-str-replace-editor），
 * `write`/`edit` 的是 `file_path`（官方 tool-fs）。
 */
export const MUTATION_TOOL_PATH_ARGS: Readonly<Record<string, readonly string[]>> = {
  write: ['file_path'],
  edit: ['file_path'],
  str_replace_editor: ['path'],
}

/** 直接改文件的命令（命令名精确匹配）。 */
const WRITE_COMMANDS = new Set([
  'touch', 'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'ln', 'truncate', 'dd', 'tee',
  'chmod', 'chown', 'chgrp', 'install', 'mktemp', 'mkfifo', 'unlink', 'shred',
  'rsync', 'tar', 'unzip', 'gunzip', 'sed', 'perl', 'patch',
])

/** 只在这些子命令下才构成「改仓库」的 `git` 子命令。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'revert', 'merge',
  'rebase', 'cherry-pick', 'apply', 'am', 'clean', 'stash', 'rm', 'mv', 'push',
  'fetch', 'pull', 'init', 'clone', 'tag', 'update-ref', 'gc', 'prune',
])

/**
 * fork（corum）2026-09-27：**仓库级写**的 `git` 子命令——它们改的是**共享的 `.git`**
 * （refs / 配置 / 其它 worktree / 远端跟踪引用），不是当前 worktree 的私有状态。
 *
 * ## 为什么单列一张表（而不是并进 {@link GIT_WRITE_SUBCOMMANDS}）
 *
 * 两者的判定后果不同：`GIT_WRITE_SUBCOMMANDS` 只决定「要不要审命令里的绝对路径」，
 * 而本表决定「**没有**绝对路径时也要拒」。实测依据（2026-09-27 指挥模式会话
 * `corum-task-56b7d485`，01:11:30）：隔离子会话 `5ddbd46e` 用
 * `git worktree remove --force .corum-worktrees/wt-471e5f` 与 `git branch -D wt/wt-471e5f`
 * —— 两条命令**都不含绝对路径**，文本门禁因此放行、只被沙箱拦下；用户点一次「允许一次」
 * 就真的删掉了主仓的 worktree 与分支（子 Agent 随后不得不自行把分支恢复）。
 *
 * 用户裁定（2026-09-27）：「子 Agent 不能操作除自己 worktree 之外的其它分支（可读）」，
 * 且这一类越界**不可提权获得** ⇒ 必须在门禁层硬拒，而不是留给沙箱 + 审批卡。
 *
 * ## 双用途子命令按**只读形态**豁免（否则会误伤裁定的另一半「可读」）
 *
 * 本表多数子命令既能读也能写：`git -C <主树> branch --list`、`git worktree list`、
 * `git config --get`、`git remote -v` 都是**读**，而隔离明说 reads are still allowed
 * ⇒ 由 {@link isGitReadOnlyForm} 逐个识别只读形态；识别不出写形态的**不拒**。
 *
 * ## 刻意**不**进本表的两类
 *
 *  · `init` / `clone`：写的是**目标目录**（不是共享 `.git`），且用户 2026-09-27 裁定
 *    「嵌套新仓是独立产物」⇒ 它们留在 {@link GIT_WRITE_SUBCOMMANDS} 走路径判定：
 *    `git init foo`（相对路径，落在自己 worktree 内）放行，`git init /仓外/x` 交权限层。
 *  · `add`/`commit`/`merge`/`checkout`/`switch`/`reset`/`stash`/… ：作用域是**当前
 *    worktree 自己的** index / HEAD / 分支（子 Agent 必须能提交与合并自己的分支）。
 */
const GIT_REPO_GLOBAL_SUBCOMMANDS = new Set([
  'worktree', 'branch', 'tag', 'config', 'remote', 'submodule', 'update-ref',
  'symbolic-ref', 'notes', 'replace', 'filter-branch', 'filter-repo',
  'gc', 'prune', 'repack', 'pack-refs', 'reflog', 'push', 'fetch', 'pull',
  'sparse-checkout', 'bisect',
])

/**
 * 仓库级子命令的**只读形态**识别器（返回 `true` = 这条只是读）。
 *
 * 只登记「确定的读」：识别器缺失或未命中 ⇒ 视为写（保守）。`symbolic-ref` 需要数位置
 * 参数，不走本表（见 {@link isGitReadOnlyForm}）。正则都以 `git <sub>` 所在的**单段**
 * （{@link shellSegments} 切开后的段）为输入。
 */
const GIT_READ_ONLY_FORMS: Readonly<Record<string, (segment: string) => boolean>> = {
  worktree: segment => /(^|\s)list(\s|$)/.test(segment),
  branch: segment => /(^|\s)(--list|-l|-a|-r|-v|-vv|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--format|--sort|--column)(\s|$)/.test(segment)
    || /^git\s+branch\s*$/.test(segment),
  tag: segment => /(^|\s)(-l|--list|-n\d*|--contains|--merged|--points-at|--format|--sort|--column)(\s|$)/.test(segment)
    || /^git\s+tag\s*$/.test(segment),
  config: segment => /(^|\s)(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope)(\s|$)/.test(segment),
  remote: segment => /(^|\s)(-v|--verbose|show|get-url)(\s|$)/.test(segment) || /^git\s+remote\s*$/.test(segment),
  submodule: segment => /(^|\s)(status|summary)(\s|$)/.test(segment),
  notes: segment => /(^|\s)(list|show)(\s|$)/.test(segment) || /^git\s+notes\s*$/.test(segment),
  reflog: segment => /(^|\s)(show|exists)(\s|$)/.test(segment) || /^git\s+reflog\s*$/.test(segment),
  'sparse-checkout': segment => /(^|\s)list(\s|$)/.test(segment),
  bisect: segment => /(^|\s)(log|view|visualize)(\s|$)/.test(segment),
}

/**
 * **裸形态即只读**的仓库级子命令：不带位置参数时 git 只是打印列表/用法，不写任何东西。
 *
 * 为什么必须单列（2026-09-27 自查到的误伤面）：本表的存在让这些子命令进了「写形态」，
 * 而写形态在**只读门禁**（指挥模式主 Agent 的只读 shell、研究子会话）下会被拒——
 * `git config user.email`、`git branch`、`git tag`、`git worktree`、`git remote` 这类
 * **无 flag 的读法**极常用，误伤一次就白烧一轮往返（本仓已有同类学费记录）。
 *
 * ⚠️ 刻意**不**含 `gc` / `prune` / `repack` / `fetch` / `pull` / `push` / `pack-refs` /
 * `filter-branch` / `filter-repo` / `update-ref`：它们**裸跑就是写**（`git gc` 不传参数
 * 照样回收对象，`git push` 会把当前分支推上去）。
 */
/**
 * 各仓库级子命令的**写开关**（合并短开关展开后逐个比对）。
 *
 * 为什么必须有它（2026-09-27 自查）：`expandShortFlags` 把 `-dav` 展成 `-d -a -v`，
 * 而 `branch` 的只读正则只要见到 `-a` 就判读 ⇒ **`git branch -dav`（删分支 + 列表）被误放行**。
 * 「含读字母」不等于「只是读」：只要出现任一写开关，整条就是写形态。
 */
const GIT_WRITE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // 只登记「会与读字母**合并**成同一个 token、从而被只读正则误读」的写开关：
  //   · `-dav` / `-Davv` / `-mv` —— `-d`/`-D`/`-m`/`-M` + 读字母。
  //   · `-c` / `-C` **刻意排除**：`-C <dir>` 是 git 的**全局**选项（`git -C /repo branch -a`），
  //     与 `git branch -C`（复制分支）同名；它们本来也不是读 flag，交回只读正则判即可
  //     （没有读 flag ⇒ 判写）。首版把 `-C` 放进本表，实测把 `git -C /repo branch -a`
  //     误判成写（自己的用例逮到）。
  branch: ['-d', '-D', '-m', '-M'],
  // tag 的 `-a`/`-s`/`-m`/`-f` 都不是 git 全局选项，可安全登记（`-n` 是读）。
  tag: ['-d', '-a', '-s', '-f', '-m'],
}

const GIT_BARE_IS_READ = new Set([
  'branch', 'tag', 'worktree', 'remote', 'notes', 'reflog', 'submodule',
  'replace', 'sparse-checkout', 'bisect', 'symbolic-ref', 'config',
])

/**
 * 把 **合并短开关**（`-avv`、`-ra`、`-vv`）展开成 `-a -v -v`，供只读形态正则匹配。
 *
 * ## 为什么必须展开（2026-09-27 实机误伤）
 *
 * 隔离子会话按 brief 跑了 `git branch -avv`（纯读：列全部分支 + 两个 v 的详情）却被硬拒——
 * 因为只读正则是按**整 token** 匹配 `-a` / `-vv` 的，`-avv` 两个都不是。git 的短开关可以
 * 合并，凡「读 + 读」的组合（`-avv` / `-rv` / `-vvv` / `-al`…）都该是读。
 *
 * 只展开「2 个及以上字母」的 token：`-C`（带取值的全局选项）与 `-m`、`-d` 这类单字母写开关
 * 原样保留，不会因此变成读。
 *
 * @param segment - 单个 shell 段。
 * @returns 展开后的段（仅用于只读形态判定，不改命令本身）。
 */
function expandShortFlags(segment: string): string {
  return segment
    .split(/\s+/)
    .map(token => /^-[a-zA-Z]{2,}$/.test(token) ? token.slice(1).split('').map(char => `-${char}`).join(' ') : token)
    .join(' ')
}

/**
 * 该段里的仓库级子命令是否只是**只读形态**。
 * @param sub - 子命令名（{@link subcommandOf} 的产物）。
 * @param segment - 该子命令所在的单个 shell 段。
 */
function isGitReadOnlyForm(sub: string, segment: string): boolean {
  // 位置参数自子命令起算（第 1 个元素就是子命令本身），已跳过选项取值。
  const positionals = positionalsFromSubcommand(segment)
  const expanded = expandShortFlags(segment)
  // ⚠️ 写开关必须**先于**「裸形态=读」判定：`git branch -dav` 没有任何**位置参数**，
  // 会被裸形态规则当成「打印用法」而放行，可它含 `-d`（删分支）。首版顺序写反，实测被
  // 自己的用例逮到（`-dav` / `-Davv` 两条红）。
  const writeFlags = GIT_WRITE_FLAGS[sub]
  if (writeFlags !== undefined && writeFlags.some(flag => expanded.split(/\s+/).includes(flag))) return false
  // 裸形态（除子命令外没有位置参数）= 打印列表/用法 ⇒ 只读。
  if (GIT_BARE_IS_READ.has(sub) && positionals.length <= 1) return true
  if (sub === 'symbolic-ref') {
    // `git symbolic-ref HEAD` 只打印；带第二个位置参数（`… HEAD refs/heads/x`）才是改引用。
    // ⚠️ 必须用**跳过选项取值**后的位置参数（`git -C /repo symbolic-ref HEAD` 里的 `/repo`
    // 是 `-C` 的取值，不是位置参数——首版按 token 数硬数，把这条只读命令误判成写）。
    return positionals.length <= 2  // [子命令, HEAD]
  }
  // `git config <key>` 是读（打印值），`git config <key> <value>` 才写：与 symbolic-ref
  // 同款的位置参数判据。带显式读 flag 的一律读。
  if (sub === 'config') {
    return /(^|\s)(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope)(\s|$)/.test(expanded)
      || positionals.length <= 2
  }
  const reader = GIT_READ_ONLY_FORMS[sub]
  return reader !== undefined && reader(expanded)
}

/**
 * 命令里是否出现**仓库级写**（{@link GIT_REPO_GLOBAL_SUBCOMMANDS} 的写形态）。
 *
 * 与 {@link detectBashWrite} 同源：后者把它算作一种写形态（于是只读门禁也拦），本函数把
 * 子命令名单独交出来，供写边界门禁判定「这条无绝对路径的写是否打在共享 `.git` 上」。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 命中的子命令名；没有时 `undefined`。
 */
export function gitRepoSideEffects(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    if (commandWordOf(segment) !== 'git') continue
    const sub = subcommandOf(segment)
    if (sub === undefined) continue
    // ⚠️ 刻意**不**跳过 `GIT_WRITE_SUBCOMMANDS` 的成员：两张表是**重叠**的（`push` / `fetch`
    // / `pull` / `tag` / `update-ref` / `gc` / `prune` 既改仓库又改共享 `.git`）。首版多写了
    // 一句 skip，于是 `git push` / `git tag v1` / `git gc` 这些**无绝对路径**的仓库级写
    // 全部漏判——本文件的新用例当场抓到（6 条红）。
    if (!GIT_REPO_GLOBAL_SUBCOMMANDS.has(sub)) continue
    if (isGitReadOnlyForm(sub, segment)) continue
    return sub
  }
  return undefined
}

/**
 * 「选项 + 取值」形态的选项名（子命令定位必须连带跳过取值）。
 *
 * 刻意**只登记有把握的那几个**（不带取值的短开关一律不进本表，避免把值当选项跳过而
 * 误判）：`git -C <dir>` / `git -c <k=v>` / `git --git-dir <path>` 等，以及 `pnpm -C`。
 * 漏登记的后果是「这个子命令判不出来」（回到改动前的**漏判**，安全侧），**不会**误伤
 * 只读命令——故按「够用即止」维护，不做通用 shell 解析。
 */
const OPTIONS_TAKING_A_VALUE = new Set([
  '-C', '-c', '--git-dir', '--git-common-dir', '--work-tree', '--namespace', '--exec-path',
])

/** 会写盘的包管理器。 */
const PACKAGE_COMMANDS = new Set(['pnpm', 'npm', 'yarn', 'bun'])

/** 包管理器里才构成写入的子命令。 */
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'link', 'publish', 'deploy',
])

/** 会把内联代码写进文件的解释器（按内容特征判定，避免误伤纯计算）。 */
const INLINE_WRITE_PATTERNS: readonly RegExp[] = [
  /open\s*\([^)]*['"][wa]/,              // python: open('f','w')
  /writeFileSync|appendFileSync|createWriteStream/,  // node
  /Path\([^)]*\)\.write_text|\.write_bytes/,         // python pathlib
  />\s*['"]?[\w./-]+/,                   // shell 重定向写在 -c 字符串里
]

/**
 * 去掉单/双引号包裹的**字面量内容**，只留引号本身之外的 shell 语法。
 *
 * 为什么必须剥（2026-09-22 实测的误报）：重定向正则原本直接在原文上匹配，于是
 * `echo '===saveProfileRemote->persist callsite==='` 里的 `->` 被当成重定向 ⇒
 * **一条纯只读命令被只读门禁拒绝**（会话 `corum-task-ef3f751e` turn 4 step 5，
 * 白烧一次往返）。引号里的 `>` 是字符串内容，shell 不会当重定向。
 *
 * 注意**只**用于重定向判定与命令名提取：内联解释器的写盘特征（
 * {@link INLINE_WRITE_PATTERNS}）恰恰长在**引号里**（`node -e "writeFileSync(...)"`），
 * 故那些判定必须继续用未剥的原文。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 引号内容被清空的命令文本（引号本身保留，以维持段结构）。
 */
export function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
}

/** 拆一条 shell 命令为「按运算符切开的段」（不求完备，只为定位真正的命令名）。 */
function shellSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/** 去掉 `sudo` / `env` / `nohup` / `time` / 环境变量赋值前缀，露出真正的命令名。 */
function commandWordOf(segment: string): string {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }        // VAR=value
    if (['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec'].includes(token)) { index += 1; continue }
    break
  }
  const raw = tokens[index] ?? ''
  // 去掉路径前缀（/bin/rm → rm）
  return raw.split('/').pop() ?? raw
}

/**
 * 段内**自子命令起**的全部位置参数（第 1 个元素就是子命令本身），跳过选项与其取值。
 *
 * ## 为什么必须跳过选项（2026-09-22 实测缺陷，**改动前就存在**）
 *
 * 原实现直接取 `tokens[index + 1]`，于是 `git -C /repo merge` 的「第二个词」是 `-C`
 * 而不是 `merge` ⇒ {@link detectBashWrite} 判不出这是写形态 ⇒ **`git -C <主树> merge`
 * 这条越界命令在只读门禁下也从未被拦过**（实测会话 `corum-task-ef3f751e` 的 worker
 * 正是用它把分支并进了主树）。凡「选项带取值」的形态都会踩中：`git -C /repo`、
 * `git --git-dir=/repo/.git`、`rm -rf /repo/x`（`rm` 靠命令名已能判，但同类形态一致处理）。
 *
 * 判据：跳过 `-x` 短选项；**已知带取值的全局选项**（`-C` / `--git-dir` / `--work-tree`
 * 等）连带跳过它的值；`--opt=value` 是一体，直接跳过自身。
 *
 * @param segment - 一条 shell 段（已按运算符切开）。
 * @returns 第一个非选项词；不存在时 `undefined`。
 */
function positionalsFromSubcommand(segment: string): string[] {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
    if (['sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec'].includes(token)) { index += 1; continue }
    break
  }
  // 跳过命令名本身
  index += 1
  const positionals: string[] = []
  while (index < tokens.length) {
    const token = tokens[index]!
    if (!token.startsWith('-')) { positionals.push(token); index += 1; continue }
    // `--opt=value` 一体：跳过自身即可
    if (token.startsWith('--') && token.includes('=')) { index += 1; continue }
    // 已知「选项 + 取值」形态：连带跳过取值（`git -C /repo merge` 的关键）
    if (OPTIONS_TAKING_A_VALUE.has(token)) { index += 2; continue }
    index += 1
  }
  return positionals
}

/**
 * 段内**自子命令起**的全部位置参数（第 1 个元素就是子命令本身），跳过选项与其取值。
 *
 * ## 为什么必须跳过选项（2026-09-22 实测缺陷，**改动前就存在**）
 *
 * 原实现直接取 `tokens[index + 1]`，于是 `git -C /repo merge` 的「第二个词」是 `-C`
 * 而不是 `merge` ⇒ {@link detectBashWrite} 判不出这是写形态 ⇒ **`git -C <主树> merge`
 * 这条越界命令在只读门禁下也从未被拦过**（实测会话 `corum-task-ef3f751e` 的 worker
 * 正是用它把分支并进了主树）。凡「选项带取值」的形态都会踩中：`git -C /repo`、
 * `git --git-dir=/repo/.git`、`rm -rf /repo/x`（`rm` 靠命令名已能判，但同类形态一致处理）。
 *
 * 判据：跳过 `-x` 短选项；**已知带取值的全局选项**（`-C` / `--git-dir` / `--work-tree`
 * 等）连带跳过它的值；`--opt=value` 是一体，直接跳过自身。实现与
 * {@link positionalsFromSubcommand} 同源（本函数取它的第一个元素）。
 *
 * @param segment - 一条 shell 段（已按运算符切开）。
 * @returns 第一个非选项词；不存在时 `undefined`。
 */
function subcommandOf(segment: string): string | undefined {
  return positionalsFromSubcommand(segment)[0]
}

/**
 * 判定一条 bash 命令**是否试图写盘**——只读门禁与写边界门禁共同的判据。
 *
 * ⚠️ **这是启发式，不是完备的 shell 语义分析**（如实标注）。设计取舍：
 * - 按**命令名**判定而不是全文匹配，避免把 `grep "rm " f` 误判成删除；
 * - 覆盖高频写形态（重定向 / in-place 编辑 / 文件与 git 与包管理器变更 / 内联解释器写盘）；
 * - 宁可**漏判也不误伤**只读工作（误伤会让 Agent 反复撞墙、白烧往返）。
 *
 * 因此它定位是**纵深防御的一层**而非唯一屏障：`write`/`edit` 已由 `tools.restrict`
 * 从工具面摘除（只读场景）；若将来能用「会话级不可覆盖的沙箱」表达只读，门禁可退为兜底。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 命中的写形态描述（用于拒绝文案）；只读时 `undefined`。
 */
export function detectBashWrite(command: string): string | undefined {
  // 1) 重定向。在**剥掉引号字面量**的文本上判定（引号里的 `>` 不是重定向，
  //    见 stripQuoted 的误报记录）。排除两类**无害形态**（否则会误伤常见只读写法）：
  //    · fd 复制：`2>&1` / `>&2`
  //    · 写入 `/dev/null`：丢弃输出是惯用只读手法，不产生任何文件
  const unquoted = stripQuoted(command)
  const withoutFd = unquoted.replace(/\d?>>?\s*&\s*\d/g, '')
  const withoutDevNull = withoutFd.replace(/>>?\s*\/dev\/null\b/g, '')
  if (/(^|[^>])>>?\s*(?!&\s*\d)(?=\S)/.test(withoutDevNull)) {
    return 'shell redirection writes to a file'
  }

  for (const segment of shellSegments(command)) {
    const word = commandWordOf(segment)
    const sub = subcommandOf(segment)

    if (WRITE_COMMANDS.has(word)) {
      // `sed` / `perl` / `patch` / `tar` 只有带写选项才算写；其余默认算写。
      if (word === 'sed') { if (/(^|\s)-i/.test(segment)) return '`sed -i` edits a file in place' ; continue }
      if (word === 'perl') { if (/(^|\s)-[a-zA-Z]*i/.test(segment)) return '`perl -i` edits a file in place'; continue }
      if (word === 'patch') return '`patch` modifies files'
      if (word === 'tar') { if (/(^|\s)-[a-zA-Z]*[xc]/.test(segment)) return '`tar` extracts or creates files'; continue }
      if (word === 'unzip' || word === 'gunzip') return `\`${word}\` writes files`
      if (word === 'rsync') return '`rsync` writes files'
      return `\`${word}\` writes to the filesystem`
    }

    if (word === 'git' && sub !== undefined && GIT_WRITE_SUBCOMMANDS.has(sub)) {
      return `\`git ${sub}\` changes the repository`
    }
    // fork（corum）2026-09-27：**仓库级写**（共享 `.git`：refs / 其它 worktree / 配置）。
    // 它必须算写形态，否则「无绝对路径 ⇒ 放行」这条会把 `git worktree remove --force x`
    // 与 `git branch -D wt/x` 直接放过（实测 2026-09-27 会话 corum-task-56b7d485 的
    // 01:11:30 事件）。只读形态（`branch --list` / `worktree list` / `config --get` …）
    // 仍然放行——隔离不限制读。
    if (word === 'git' && sub !== undefined && GIT_REPO_GLOBAL_SUBCOMMANDS.has(sub)
      && !isGitReadOnlyForm(sub, segment)) {
      return `\`git ${sub}\` changes the shared repository`
    }
    if (PACKAGE_COMMANDS.has(word) && sub !== undefined && PACKAGE_WRITE_SUBCOMMANDS.has(sub)) {
      return `\`${word} ${sub}\` installs or modifies dependencies`
    }
    // 内联解释器里写盘（**用未剥引号的原文**：写盘特征就在引号里）
    if (['python', 'python3', 'node', 'ruby', 'perl'].includes(word)) {
      for (const pattern of INLINE_WRITE_PATTERNS) {
        if (pattern.test(segment)) return 'inline script writes to a file'
      }
    }
  }
  return undefined
}

/**
 * 目标路径是否落在某个根之内（词法判定，根与目标都已 resolve）。
 *
 * 与官方 `dsh-fs-sandbox` 的 `isPathUnder` 相比少了两件事：不做 realpath/设备号
 * 等价判定，也不处理 Windows 大小写别名——**有意如此**。本函数服务的是
 * {@link confinementGuard}（纵深防御的一层启发式门禁），真正的强边界是
 * `workspace-write` 沙箱本身（它做完整判定）。门禁若在这里做重量级 syscall，
 * 只会让热路径变慢而不增加保证。
 *
 * @param target - 已 resolve 的目标绝对路径。
 * @param root - 已 resolve 的根绝对路径。
 * @returns 目标等于根或位于其下时为 true。
 */
export function isPathInside(target: string, root: string): boolean {
  if (process.platform === 'win32') {
    // win32 文件系统大小写不敏感：`D:\MAIN\x` 须识别为 inside `D:\main`，
    // 否则混合大小写路径的越界写漏判（confinementGuard 不拒）。
    const lt = target.toLowerCase(), lr = root.toLowerCase()
    if (lt === lr) return true
    const prefix = lr.endsWith(path.sep) ? lr : lr + path.sep
    return lt.startsWith(prefix)
  }
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

/**
 * 从一条 shell 命令里提取**显式写出的绝对路径**（`/...`）与家目录简写（`~`/`$HOME`）。
 *
 * 覆盖三种出现位置：独立参数、`--opt=/abs`、以及 `-C /abs` / `--git-dir /abs`
 * 这类「选项与值分列」的形态（后者正是 `git -C <主树> merge` 这种越界的载体）。
 *
 * 有意**不**提取相对路径：子会话 cwd 就是 worktree，相对路径天然落在边界内。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @returns 去重后的越界候选（绝对路径已 resolve；`~`/`$HOME` 原样标记）。
 */
export function absolutePathsIn(command: string): string[] {
  const found = new Set<string>()
  // 独立出现的 /abs 或 --opt=/abs（引号内外的都算：写形态下的绝对路径一律要审）
  for (const match of command.matchAll(/(?:^|[\s='"])(\/[^\s'"|;&()<>]*)/g)) {
    const raw = match[1]
    if (raw !== undefined && raw !== '/' && !raw.startsWith('//')) found.add(path.resolve(raw))
  }
  // fork（corum）win32 适配（P0-2，安全面）：增补盘符路径与 UNC 路径提取。
  //
  // 由来：旧正则只覆盖 POSIX `/abs`，win32 上 `git -C D:\主仓 merge` / `rm -rf \\server\share\x`
  // 的写目标不被提取 ⇒ 写目标列表为空 ⇒ 门禁放行越界写（安全红线：漏判优先于误判）。
  //
  // 正则口径与任务 1 的 `win32-path-helpers` 完全一致（`^[A-Za-z]:[\\/]` 盘符、`^[/\\]{2}` UNC）；
  // `cdTargetsOf` 的单 arg 判定复用 `isWindowsAbsolutePath`，此处提取面必须用正则扫文本。
  //
  // 引号内的盘符路径（含空格）：`"D:\my path\x"` / `'D:\my path\x'`
  // 由来（P1）：旧正则的路径段 `[^\s'"|;&()<>]*` 在空格处截断，含空格的引号路径只提取前半段
  // （`D:\my`）⇒ 越界写目标漏判（安全红线：漏判优先于误判）。此处完整提取引号内路径，
  // 引号本身剥离（不进 path.resolve）；盘符分支前缀不再含 `"`/`'`，避免重复与截断噪音候选。
  for (const match of command.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'/g)) {
    const raw = match[1] ?? match[2]
    if (raw !== undefined) found.add(path.resolve(raw))
  }
  // 盘符路径：`D:\target`、`C:/target`（分隔符可混写）；含重定向目标 `>D:\target`（`>` 前缀，
  // 覆盖 `>D:\x` / `>>D:\x` / `2>D:\x` 等形态）。前缀不含 `"`/`'`：引号内路径由上一循环完整处理。
  for (const match of command.matchAll(/(?:^|[\s=>])([A-Za-z]:[\\/][^\s'"|;&()<>]*)/g)) {
    const raw = match[1]
    if (raw !== undefined) found.add(path.resolve(raw))
  }
  // UNC 路径：`\\server\share\target`、`//server/share/target`（双分隔符开头，可混写）
  // 注意：POSIX 正则已排除 `//` 开头（POSIX 下 `//` 非合法路径），此处 UNC 正则把 `//server/share`
  // 作为 UNC 提取（win32 合法形态）；Set 去重保证不重复。
  // fork 门控（P3）：仅在 win32 上提取 UNC —— POSIX 上 `//server/share` 是相对路径（`//` 非
  // 合法 UNC），既有 POSIX 正则已用 `!raw.startsWith('//')` 排除 `//` 前缀；此处须同样门控，
  // 否则 POSIX 上 `//server/share` 进入写目标候选集，与 POSIX 分支口径矛盾。
  if (process.platform === 'win32') {
    for (const match of command.matchAll(/(?:^|[\s='"])([/\\]{2}[^\s'"|;&()<>]*)/g)) {
      const raw = match[1]
      if (raw !== undefined) found.add(path.resolve(raw))
    }
  }
  // 家目录简写
  if (/(^|[\s='"])~(?=[/\s'"]|$)/.test(command) || /\$HOME\b|\$\{HOME\}/.test(command)) {
    found.add('~')
  }
  return [...found]
}

/**
 * 越界种类——**唯一**区分「哪条轴」的词汇表（用户 2026-09-27 裁定）。
 *
 * - `parent-tree`：目标落在**当前仓库**里（含共享 `.git`、其它 worktree、其它分支），
 *   或是一次作用于共享 `.git` 的仓库级写。⇒ **硬拒，且不可提权获得**。
 * - `outside`：目标在当前仓库**之外**（另一个仓、家目录、系统路径……）。隔离的用意是
 *   「并发改写不互相踩」，与「能不能碰仓外的东西」是**两条正交的轴** ⇒ 这里只报告种类，
 *   由沙箱与审批决定（**可提权**），门禁本身**弃权**。
 *
 * 两层的策略因此共用同一个判定（单一事实源，规范 §4a 的「两处对账」纪律）：
 * {@link confinementGuard} 只拒 `parent-tree`；`corum-subagent` 的提权应答器对
 * `parent-tree` 直接 refuse（连审批卡都不出，会话级授权也豁免不了）。
 */
export type ConfinementViolationKind = 'parent-tree' | 'outside'

/** 一次越界判定（`undefined` = 不表态：非写形态 / 无越界目标）。 */
export interface ConfinementViolation {
  readonly kind: ConfinementViolationKind
  /** 可读原因（既用于拒绝文案，也用于测试断言；不含「isolated child:」前缀）。 */
  readonly reason: string
}

/** 写边界门禁的作用域。 */
export interface ConfinementScope {
  /** 隔离子会话的 worktree 根（= 子会话 `header.cwd`）。 */
  readonly worktreeRoot: string
  /** 委派方的**主工作树**根（隔离要保护的对象）；缺省时退化为「只有 worktree 边界」。 */
  readonly parentTreeRoot?: string | undefined
}

/** 一条 shell 命令里的写目标（供门禁判定与单测直接驱动）。 */
export interface ConfinementExecution {
  readonly name: string
  readonly arguments?: unknown
}

/**
 * 取出命令里 `cd` / `pushd` 的**目标序列**（按段出现顺序，从 `start` 起算）。
 *
 * ## 为什么必须自己跟踪 cwd（2026-09-27 实测的漏判）
 *
 * 旧口径只看「命令文本里出现的**绝对路径**」，理由是「子会话 cwd 就是 worktree，相对路径
 * 天然在界内」。该前提在 `cd` 之后就失效了：实测越界命令**三条全都以
 * `cd /Users/kukucai/work/kkc-desktop` 开头**，随后的 `git worktree remove --force
 * .corum-worktrees/wt-471e5f` 用的是**相对路径** ⇒ 绝对路径列表为空 ⇒ 门禁放行
 * （`git worktree` 当时还不在任何写名单里，两道一起漏）。
 *
 * 于是：`cd` 到主仓（含 `cd ../..` 这类穿越）**本身**就是越界信号——它让后续所有相对
 * 路径写都落在主仓里。目标按 `path.resolve(当前 cwd, 参数)` 逐个解析，`~` / `$HOME`
 * 记成哨兵 `'~'`（与 {@link absolutePathsIn} 同一口径），`cd -` 等无法词法解析的形态
 * 保守地也记 `'~'`。
 *
 * @param command - bash 工具的 `command` 参数原文。
 * @param start - 起始 cwd（隔离子会话 = worktree 根）。
 * @returns 解析后的 `cd` 目标序列（可能为空）。
 */
function cdTargetsOf(command: string, start: string): string[] {
  const targets: string[] = []
  let cwd = start
  for (const segment of shellSegments(command)) {
    // 子 shell / 代码块形态 `(cd x && …)`、`{ cd x; …; }`：剥掉前导括号再取命令词。
    const bare = segment.replace(/^[({]+/, '').trim()
    const word = commandWordOf(bare)
    if (word !== 'cd' && word !== 'pushd') continue
    const arg = bare.split(/\s+/).filter(Boolean).slice(1).find(token => !token.startsWith('-'))
    if (arg === undefined || arg === '-' || arg === '~' || arg.startsWith('~/')
      || arg === '$HOME' || arg.startsWith('$HOME/') || arg.startsWith('${HOME}')) {
      targets.push('~')
      cwd = '~'
      continue
    }
    // fork（corum）win32 适配（P0-2）：绝对路径判据从 `arg.startsWith('/')` 扩为
    // 「`/` 开头 **或** win32 盘符/UNC 开头」。否则 win32 上 `cd D:\主仓` 会被当相对
    // 路径走 `path.resolve(cwd, arg)` ⇒ 越界判定失真（复用 isWindowsAbsolutePath 判定，
    // 不另写正则）。POSIX 分支行为不变（isWindowsAbsolutePath 对 POSIX 路径返回 false）。
    if (!arg.startsWith('/') && !isWindowsAbsolutePath(arg)) {
      if (cwd === '~') { targets.push('~'); continue }
      cwd = path.resolve(cwd, arg)
      targets.push(cwd)
      continue
    }
    cwd = path.resolve(arg)
    targets.push(cwd)
  }
  return targets
}

/**
 * 一条 shell 命令的全部写目标候选 = 显式绝对路径 / 家目录简写（{@link absolutePathsIn}）
 * + `cd` 目标（{@link cdTargetsOf}）。去重，顺序保留。
 */
function writeTargetsOf(command: string, start: string): string[] {
  const seen = new Set<string>(absolutePathsIn(command))
  for (const target of cdTargetsOf(command, start)) seen.add(target)
  return [...seen]
}

/**
 * **隔离子会话写边界的唯一判定**（用户 2026-09-27 裁定后的两轴口径）。
 *
 * ## 判定
 *
 * - **变异工具**（`write`/`edit`/`str_replace_editor`）：路径参数 resolve 后落在
 *   `parentTreeRoot` 内 ⇒ `parent-tree`；落在 worktree 与临时区之外 ⇒ `outside`。
 * - **shell**（`bash`/`pwsh`）：先过 {@link detectBashWrite}——**只读命令一律不表态**
 *   （隔离不限制读，通知里明说「reads are still allowed for reference」）；
 *   写形态再逐个审写目标：`parent-tree` 优先于 `outside`（多目标命令里只要有一个打在
 *   主仓上，整条就必须按硬线处理——否则 `cp 仓外 主仓` 会因先命中仓外而变成可提权）。
 * - **无越界目标的仓库级写**（{@link gitRepoSideEffects}）：`git branch -D` / `git worktree
 *   remove` / `git push` 这类改共享 `.git` 的命令**文本里没有绝对路径**，却作用于主仓
 *   的其它分支与 worktree ⇒ `parent-tree`。唯一的例外是命令先 `cd` 进了 worktree 的
 *   **子孙目录**（例如 worktree 内新建的独立仓，用户裁定它是独立产物）——那时
 *   `git config` 打的是那个仓自己的 `.git`，门禁不表态，交由沙箱按路径判定。
 * - 其余工具：不表态（abstain）。
 *
 * @param scope - 作用域（worktree 根 + 主树根）。
 * @param execution - 一次工具调用（工具名 + 参数）。
 * @returns 越界判定；不表态时 `undefined`。
 */
export function confinementViolation(
  scope: ConfinementScope,
  execution: ConfinementExecution,
): ConfinementViolation | undefined {
  const root = path.resolve(scope.worktreeRoot)
  const parentTree = scope.parentTreeRoot === undefined || scope.parentTreeRoot === ''
    ? undefined
    : path.resolve(scope.parentTreeRoot)
  // 允许集与官方 `writableRoots` 的「workspace + /tmp + tmpdir」口径一致：在 /tmp 造
  // fixture 是 build/test 的常见需要，拦它只会制造误伤。真正的边界仍是沙箱（fix 1）。
  const allowed = [root, ...confinementTempRoots()]
  const inside = (candidate: string): boolean => allowed.some(entry => isPathInside(candidate, entry))
  /** 主工作树**优先于**允许集：工作区在临时区里时，临时允许不能把它一起放行。 */
  const inParentTree = (candidate: string): boolean =>
    parentTree !== undefined && isPathInside(candidate, parentTree) && !isPathInside(candidate, root)

  const args = execution.arguments
  const argRecord = typeof args === 'object' && args !== null ? args as Record<string, unknown> : undefined

  const pathArgs = MUTATION_TOOL_PATH_ARGS[execution.name]
  if (pathArgs !== undefined && argRecord !== undefined) {
    let outside: ConfinementViolation | undefined
    for (const key of pathArgs) {
      const value = argRecord[key]
      if (typeof value !== 'string' || value === '') continue
      const resolved = path.resolve(root, value)
      if (inParentTree(resolved)) {
        return { kind: 'parent-tree', reason: `${execution.name} targets "${value}" in the parent working tree` }
      }
      if (!inside(resolved)) {
        outside ??= { kind: 'outside', reason: `${execution.name} targets "${value}" outside the worktree` }
      }
    }
    return outside
  }

  if (execution.name === 'bash' || execution.name === 'pwsh') {
    const command = argRecord?.['command']
    if (typeof command !== 'string' || command === '') return undefined
    const writeForm = detectBashWrite(command)
    if (writeForm === undefined) return undefined
    let outside: ConfinementViolation | undefined
    for (const candidate of writeTargetsOf(command, root)) {
      if (candidate === '~') {
        return { kind: 'parent-tree', reason: `${writeForm} targets the home directory` }
      }
      if (inParentTree(candidate)) {
        return { kind: 'parent-tree', reason: `${writeForm} targets "${candidate}" in the parent working tree` }
      }
      if (!inside(candidate)) {
        outside ??= { kind: 'outside', reason: `${writeForm} targets "${candidate}" outside the worktree` }
      }
    }
    const global = gitRepoSideEffects(command)
    if (global !== undefined) {
      const cwd = cdTargetsOf(command, root).at(-1)
      // `cd` 到 worktree 的**子孙目录**（worktree 内新建的独立仓）不予判定——用户裁定
      // 「嵌套新仓是独立产物」；那时 `git config` 等打的是那个仓自己的 `.git`。
      const intoDescendant = cwd !== undefined && cwd !== '~' && cwd !== root && isPathInside(cwd, root)
      if (!intoDescendant) {
        return {
          kind: 'parent-tree',
          reason: `\`git ${global}\` changes the shared repository (other branches/worktrees of the parent tree)`,
        }
      }
    }
    return outside
  }

  return undefined
}

/**
 * 构造一个**隔离子会话**的写边界门禁（agent-scoped `tools.guard`）。
 *
 * ## 判定（2026-09-27 两轴口径）
 *
 * 判定本体在 {@link confinementViolation}（单一事实源，提权应答器复用同一份）。本函数只
 * 负责**策略**：`parent-tree` ⇒ 返回拒绝文案（硬拒，不可提权）；`outside` ⇒ **弃权**
 * （返回 `undefined`，交给沙箱与审批 = 权限轴，可提权获得）。
 *
 * ## 与提权应答器的分工
 *
 * 本门禁是**文本/路径启发式**的一层（快、无 syscall），强边界仍是沙箱（fix 1，隔离期
 * 子会话档位被钉成 `workspace-write`）。提权应答器复用同一判定，把「主仓目标」的提权
 * 请求直接 refuse —— 于是「不可提权获得」这条不依赖本门禁是否判出那条命令。
 *
 * ## 为什么不把 `<repo>/.git` 数据目录加进允许集
 *
 * 子会话**必须能提交**（`git add/commit` 要写 `.git` 的数据目录），而那是 worktree 之外。
 * 但它的实现方式是：git 自己按内部记录去写，**命令文本里不出现**那些绝对路径
 * （`git add -A` 没有任何绝对路径）⇒ 走「无越界目标 ⇒ 放行」这条。而 `git -C <主树> merge`
 * **会**把主树路径写进命令文本 ⇒ 被拦。若把 `.git` 数据目录加进允许集，
 * `git -C <主树> …` 就会因为主树路径不在 `.git` 下而被拒——仍拦得住；但 `<repo>/.git`
 * 的**授权语义**属于 `@corum/corum-sandbox-local` 那层（它有明确的安全评审与「不给
 * config/hooks」的边界，见 `docs/fork-delta.md` §15），本门禁不复制那份名单，避免两处漂移。
 *
 * ## 已知残余缺口（如实标注，别当成已闭合）
 *
 * 判定基于命令文本。刻意混淆路径的写法（`$(pwd)/../..`、拼字符串、`env F=/repo cmd $F`）
 * 判不出来 ⇒ 彼时靠沙箱拦（它会拒），但**沙箱那一层的提权是用户可批的** ⇒ 这类形态
 * 仍有「用户误批一次就放行」的窗口。要真正闭合需要在沙箱 fork 里按真实路径禁写主仓
 * （`docs/fork-delta.md` §15 的授权面），不在本轮范围。
 *
 * @param options.worktreeRoot - 隔离子会话的 worktree 根（= 子会话 `header.cwd`）。
 * @param options.parentTreeRoot - 委派方的**主工作树**根（隔离要保护的对象）。
 *   **拒绝优先于允许**：它即便落在临时区之内（工作区就建在 /tmp 下的场景）也照样被拒——
 *   否则临时区允许集会把它一起放行，门禁等于没装（本仓测试环境正是这种形态）。
 * @returns 门禁函数；放行返回 `undefined`，拒绝返回可操作的拒绝文案。
 */
export function confinementGuard(
  options: ConfinementScope,
): (execution: ConfinementExecution) => string | undefined {
  const root = path.resolve(options.worktreeRoot)
  return (execution) => {
    const violation = confinementViolation(options, execution)
    // 只拒「当前仓库」这一条轴。仓外目标**弃权**（返回 undefined），交给沙箱 + 审批 =
    // 权限轴（可提权获得）——用户 2026-09-27 裁定：隔离的用意是「并发改写不互相踩」，
    // 与「能不能碰仓外的东西」是两条正交的轴。旧口径把两者一起硬拒，实测代价是整个
    // 跨仓任务无法完成（会话 corum-task-56b7d485：子 Agent 带 danger-full-access 重试
    // 两次仍被同一句驳回，机制只能把搬运外包给用户，其中一条配方还因 /tmp 被回收而失效）。
    if (violation === undefined || violation.kind !== 'parent-tree') return undefined
    return `isolated child: ${violation.reason} — writes are confined to your worktree (${root}). `
      + 'Commit your work on your own branch inside the worktree; the parent (or the mechanism\'s integrator) merges it '
      + 'into the main tree. Do not write, redirect into, or run git commands against the parent working tree.'
  }
}

/**
 * fork（corum）：临时区允许集。
 *
 * 与官方 `writableRoots` 的「workspace + /tmp + tmpdir」口径一致——隔离子会话在
 * `/tmp` 造 fixture 是合法工作（build/test 的常见需要）。
 * @returns 平台临时目录（已 resolve）。
 */
export function confinementTempRoots(): string[] {
  // fork（corum）win32 适配（P0-2）：win32 上 `path.resolve('/tmp')` 解析为当前盘符下
  // `\tmp`（伪根，非真实临时目录）——把它放进允许集会让当前盘符下 `\tmp` 任意写放行，
  // 而真正的临时目录是 `tmpdir()`（如 `C:\Users\xxx\AppData\Local\Temp`）。
  // win32 分支只返回 `[tmpdir()]`；POSIX 分支保持 `[path.resolve('/tmp'), tmpdir()]` 去重。
  if (process.platform === 'win32') {
    return [path.resolve(tmpdir())]
  }
  return [...new Set([path.resolve('/tmp'), path.resolve(tmpdir())])]
}
