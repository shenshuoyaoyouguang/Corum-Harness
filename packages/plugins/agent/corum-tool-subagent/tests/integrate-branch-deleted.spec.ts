/**
 * fork（corum）集成判定回归——**「合并后删分支」不得被误判为未落地**（2026-09-20 机制 bug）。
 *
 * 事故现象（用户实测）：
 *   `subagent/orchestrate` 的集成**实际成功**，机制却抛
 *   `Error: integrate did not persist into the main tree`。
 *
 * 根因：判定按**分支名**跑 `git merge-base --is-ancestor <branch> HEAD` + `git cherry HEAD <branch>`；
 * 而「合并进 HEAD 之后 `branch -D`」正是机制自己鼓励的合规收尾
 * （`corumCleanupWorktree` 自己就删分支）。分支一没，两条命令都非零退出 ⇒ catch ⇒ false
 * ⇒ 一次真落地的集成被判失败、现场白保留、台账翻不动。
 *
 * 修法：条目记 `tip` 快照（sha），分支已删时用 `git merge-base --is-ancestor <tip> HEAD`
 * 证明并入；判定收成单一入口 `corumEntryIntegrated`（truth 与 reconcile 共享口径）。
 *
 * 本 spec 的分组与设防：
 *   A. 正向——已合并 + 已删分支 ⇒ integrated（**改前必红**）；
 *   B. 反向——未合并（分支在场 / 分支+worktree 都删 / 空分支 / 缺 tip）⇒ 仍必须 false，
 *      **门禁绝不放宽**（这是本修复最容易引入退化的方向）；
 *   C. 共享口径——corumReconcileIntegrated 与 corumIntegrationTruth 对同一现场结论一致；
 *   D. 快照落点——corumCleanupWorktree 在 `branch -D` **之前**记 tip（否则它自己删完就没证据了）。
 * 全部用真实临时 git 仓库驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  corumBranchIntegrated,
  corumBranchTip,
  corumCleanupWorktree,
  corumEntryIntegrated,
  corumGit,
  corumGitHead,
  corumIntegrationFailure,
  corumIntegrationTruth,
  corumReconcileIntegrated,
  corumShaInHead,
  corumSnapshotBranchTips,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratchDirs: string[] = []

/** 建一个真实 git 仓库 + 一个隔离 worktree/分支（复刻 spawnOne 的创建命令）。 */
function makeRepoWithWorktree(slug = 'wt-del001'): {
  repo: string
  worktree: string
  branch: string
  entry: CorumWorktreeEntry
} {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-integrate-del-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  // 台账条目的形态与机制一致：创建时记 base（= 当时的 HEAD），此时 tip === base。
  const base = corumBranchTip(repo, branch)
  return {
    repo,
    worktree,
    branch,
    entry: {
      slug,
      branch,
      path: worktree,
      status: 'settled',
      ...base === undefined ? {} : { base, tip: base },
    },
  }
}

/** 在 worktree 里写文件并提交（子 Agent 的正常产出形态）。 */
function commitInWorktree(worktree: string, file: string): string {
  writeFileSync(join(worktree, file), 'child payload')
  execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', `add ${file}`], { stdio: 'pipe' })
  return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function branchExists(repo: string, branch: string): boolean {
  return execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== ''
}

/** 复刻合规收尾：先快照 tip（机制在集成者启动前做），再 merge，再删分支 + 删 worktree。 */
function mergeThenReclaimCleanup(repo: string, entry: CorumWorktreeEntry): void {
  corumSnapshotBranchTips(repo, [entry])
  corumGit(repo, ['-c', 'user.name=int', '-c', 'user.email=int@corum.local', 'merge', '--no-ff', '-m', 'merge wt', entry.branch])
  corumGit(repo, ['worktree', 'remove', '--force', entry.path])
  corumGit(repo, ['branch', '-D', entry.branch])
}

/**
 * 删掉分支（连同其 worktree）。
 * git 不允许 `branch -D` 一条仍被 worktree 占用的分支，故顺序必须是
 * remove → branch -D（`corumCleanupWorktree` 内部同序）。
 */
function reclaimBranch(repo: string, entry: CorumWorktreeEntry): void {
  if (existsSync(entry.path)) corumGit(repo, ['worktree', 'remove', '--force', entry.path])
  corumGit(repo, ['branch', '-D', entry.branch])
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('A. 已合并 + 已删分支 → integrated（2026-09-20 机制 bug 回归）', () => {
  it('merge --no-ff 后合规删分支 ⇒ truth.integrated=true 且 unmerged 为空', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'DEL-1.txt')
    mergeThenReclaimCleanup(repo, entry)

    // 现场确实是「分支已删」：旧判定（按分支名）在这里必然 false。
    expect(branchExists(repo, branch)).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    expect(entry.tip).toBeDefined()
    expect(corumShaInHead(repo, entry.tip ?? '')).toBe(true)

    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.unmerged).toEqual([])
    expect(truth.integrated).toBe(true)
  })

  it('已删分支 + 台账条目只有 base/tip（无现场）⇒ 仍判 integrated', () => {    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-del002')
    const childTip = commitInWorktree(worktree, 'DEL-2.txt')
    corumSnapshotBranchTips(repo, [entry])
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    reclaimBranch(repo, entry)
    // 条目现已既无 worktree 也无分支——唯一证据就是 tip 快照。
    expect(existsSync(entry.path)).toBe(false)
    expect(corumBranchIntegrated(repo, branch)).toBe(false) // 按分支名的旧口径：假阴
    expect(corumEntryIntegrated(repo, entry)).toBe(true) // 按条目的新口径：真值
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(true)
    expect(childTip).toBe(entry.tip)
  })
})

describe('B. 门禁不得放宽——未合并一律仍判 false', () => {
  it('未合并 + 分支仍在场 ⇒ false（既有口径不变）', () => {
    const { repo, worktree, entry, branch } = makeRepoWithWorktree('wt-del010')
    commitInWorktree(worktree, 'DEL-10.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(false)
    expect(truth.unmerged).toEqual([branch])
  })

  it('未合并 + worktree 与分支都被删（tip 快照在，但不在 HEAD 祖先链）⇒ 仍 false', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-del011')
    commitInWorktree(worktree, 'DEL-11.txt')
    corumSnapshotBranchTips(repo, [entry]) // 快照了，但随后**没有** merge
    corumGit(repo, ['worktree', 'remove', '--force', worktree])
    corumGit(repo, ['branch', '-D', branch])

    expect(branchExists(repo, branch)).toBe(false)
    expect(corumShaInHead(repo, entry.tip ?? '')).toBe(false) // 快照存在 ≠ 已并入
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(false)
    expect(truth.unmerged).toEqual([branch])
  })

  it('空分支（tip === base）即使被删 ⇒ 不认账（与对账口径对齐）', () => {
    const { repo, branch, entry } = makeRepoWithWorktree('wt-del012')
    // 一个提交都没做：tip === base。
    expect(entry.tip).toBe(entry.base)
    reclaimBranch(repo, entry)
    expect(corumEntryIntegrated(repo, entry)).toBe(false)
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(false)
  })

  it('分支已删且**无 tip 快照**（存量条目）⇒ 保守 false，不放宽', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-del013')
    commitInWorktree(worktree, 'DEL-13.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    reclaimBranch(repo, entry)
    // 快照被抹掉（模拟 2026-09-20 之前落盘的存量条目）：机制无从证明，必须保守判失败。
    const legacy: CorumWorktreeEntry = { ...entry, tip: undefined }
    expect(corumEntryIntegrated(repo, legacy)).toBe(false)
    expect(corumIntegrationTruth(repo, [legacy]).integrated).toBe(false)
  })

  it('fast-forward 重合（tip === HEAD）⇒ 不认账（安全侧失败）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-del014')
    commitInWorktree(worktree, 'DEL-14.txt')
    corumSnapshotBranchTips(repo, [entry])
    corumGit(repo, ['merge', '--ff-only', branch]) // ff：分支 tip 直接成为 HEAD
    reclaimBranch(repo, entry)
    expect(entry.tip).toBe(corumGitHead(repo))
    expect(corumEntryIntegrated(repo, entry)).toBe(false)
  })
})

describe('C. 共享口径——reconcile 与 truth 对同一现场结论一致', () => {
  it('已合并 + 已删分支 ⇒ reconcile 翻成 integrated', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-del020')
    commitInWorktree(worktree, 'DEL-20.txt')
    mergeThenReclaimCleanup(repo, entry)
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([entry.slug])
    expect(reconciled.entries[0]?.status).toBe('integrated')
    // 与真值门禁同一结论（一套口径，不是两套）。
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(true)
  })

  it('未合并 + 已删分支 ⇒ reconcile 不翻（与 truth 的 false 一致）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-del021')
    commitInWorktree(worktree, 'DEL-21.txt')
    corumSnapshotBranchTips(repo, [entry])
    corumGit(repo, ['worktree', 'remove', '--force', worktree])
    corumGit(repo, ['branch', '-D', branch])
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
    expect(reconciled.entries[0]?.status).toBe('settled')
    expect(corumIntegrationTruth(repo, [entry]).integrated).toBe(false)
  })
})

describe('D. 快照落点——删分支之前必须先记 tip', () => {
  it('corumCleanupWorktree 自己执行 branch -D 前记下 tip', () => {
    const { repo, worktree, entry, branch } = makeRepoWithWorktree('wt-del030')
    const childTip = commitInWorktree(worktree, 'DEL-30.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    // 调用方没快照过（存量路径）：清理函数必须补上，否则删完就没证据了。
    const before: CorumWorktreeEntry = { ...entry, tip: undefined }
    expect(corumCleanupWorktree(repo, before, { force: false })).toBe(true)
    expect(branchExists(repo, branch)).toBe(false)
    expect(before.tip).toBe(childTip) // 删分支前记下的快照
    expect(corumEntryIntegrated(repo, before)).toBe(true)
  })

  it('corumSnapshotBranchTips 只刷新活分支、分支已删时保留旧快照', () => {
    const { repo, worktree, entry, branch } = makeRepoWithWorktree('wt-del031')
    commitInWorktree(worktree, 'DEL-31.txt')
    expect(corumSnapshotBranchTips(repo, [entry])).toBeGreaterThan(0)
    const kept = entry.tip
    reclaimBranch(repo, entry)
    expect(corumSnapshotBranchTips(repo, [entry])).toBe(0)
    expect(entry.tip).toBe(kept) // 旧快照仍是有效证据，不被清空
  })
})

describe('E. 失败报告不再把「已删分支」说成唯一留存', () => {
  it('unmerged 文案改为「无并入证据」，并说明合规删分支不算失败', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-del040')
    commitInWorktree(worktree, 'DEL-40.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    const message = corumIntegrationFailure(truth, 'deadbeefdeadbeef', [entry])
    expect(message).toContain('NO evidence of being integrated into HEAD')
    expect(message).toContain('sanctioned cleanup')
    expect(message).toContain('PRESERVED')
  })
})
