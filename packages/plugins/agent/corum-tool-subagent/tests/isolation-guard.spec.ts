/**
 * fork（corum）**隔离补漏**单测（2026-09-15，用户立规「必须提交」后）。
 *
 * 两条机制缺口各对应一组断言：
 *
 * **H1 · 基线不对（父树未提交 ⇒ 子看不到）**
 * 事故：子 Agent 的「Integrate BEFORE evidence branch」失败，根因是派发前父树改动未提交。
 * 链条：`git worktree add -b <branch>`（**不指定 base**）⇒ 从 HEAD 建分支；父树未提交改动
 * 不在任何提交里 ⇒ 子看不到。实证（监督侧）：父树改过的 theme.css 里新值
 * `1D112B9E` —— 父树命中 1、worktree 命中 0。
 * ⇒ 断言 `corumDirtyParentRefusal` 按**严格档**（用户 2026-09-15 裁定：含 untracked 也拦）
 * 拒绝，且 `createWorktreeChild` 在**建目录之前**就抛。
 *
 * **H2 · 收口必须提交（机制保证，不由 Agent 自己决定）**
 * 用户裁定：「无论如何每次工作结束 Agent 必须提交……要在机制上保证」，
 * 且「commit 失败后**交由模型处理并完成提交**」。
 * ⇒ 断言 `corumCommitWorktreeOnSettle` 把未提交的 worktree 提交掉（带可识别主题），
 * 干净/不存在时是安全的 no-op，失败时返回**结构化原因**（供上层投递给模型）。
 *
 * 全部用**真实临时 git 仓库**驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORUM_AUTO_COMMIT_SUBJECT,
  CorumOrchestration,
  corumCommitWorktreeOnSettle,
  corumDirtyParentRefusal,
  corumGit,
  corumGitStatusPorcelain,
  corumWorktreeHasUncommitted,
} from '../src/orchestration.ts'

const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** 真临时仓库（已 init + 一次提交，git 身份就位）。 */
function makeRepo(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-guard-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' })
  return repo
}

/** 真 worktree（= 隔离子将工作的目录）。 */
function makeWorktree(repo: string, slug = 'wt-guard01'): { worktree: string; branch: string } {
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  return { worktree, branch }
}

describe('corumDirtyParentRefusal — 隔离前置校验（严格档：任何 porcelain 行都拦）', () => {
  it('干净的父树 → 放行（undefined）', () => {
    const repo = makeRepo()
    expect(corumDirtyParentRefusal(repo)).toBeUndefined()
  })

  it('已跟踪文件被修改 → 拒绝，且原因可读（含条数与处置指引）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'seed.txt'), 'changed\n')
    const refusal = corumDirtyParentRefusal(repo)
    expect(refusal).toBeDefined()
    expect(refusal).toContain('isolation refused')
    expect(refusal).toContain('1 uncommitted change(s)')
    expect(refusal).toContain('seed.txt')
    // 必须说清「为什么」与「怎么办」——否则模型只会看到一句无用报错。
    expect(refusal).toContain('branches off HEAD')
    expect(refusal).toContain('Commit (or stash)')
  })

  it('**untracked 新源码** 同样拒绝（严格档的核心：子的树必须等于父的树）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'brand-new.ts'), 'export const x = 1\n')
    const refusal = corumDirtyParentRefusal(repo)
    expect(refusal).toBeDefined()
    expect(refusal).toContain('brand-new.ts')
  })

  it('已暂存未提交（staged）也拒绝', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    expect(corumDirtyParentRefusal(repo)).toBeDefined()
  })

  it('改动超过 5 条时给出「还有 N 条」而不是刷屏', () => {
    const repo = makeRepo()
    for (let i = 0; i < 8; i++) writeFileSync(join(repo, `f${i}.txt`), 'x\n')
    const refusal = corumDirtyParentRefusal(repo) ?? ''
    expect(refusal).toContain('8 uncommitted change(s)')
    expect(refusal).toContain('…and 3 more')
  })
})

describe('createWorktreeChild — 不变式⑤的两条配套（2026-09-16）', () => {
  // 旧断言是「脏父树 ⇒ 抛错拒绝隔离」。不变式⑤把隔离变成**每次写委派必经之路**后，那条口径
  // 会直接阻断最常见的工作流（主 Agent 在同一 turn 内改完代码再派写子 Agent，而 turn-end
  // 强制提交要到 turn 结束才发生）。故机制改为**先自动收口提交父树**再照常建 worktree；
  // 「严格门」仍在，但只在自家收口失败时才拒绝（兜底）。
  it('★ 脏父树 ⇒ 机制先自动提交父树，委派照常成功（不再阻断「改完代码立刻派活」）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'dirty.txt'), 'x\n')
    const orchestration = new CorumOrchestration(new Context())
    const child = orchestration.createWorktreeChild('session-1', repo)
    expect(existsSync(child.path)).toBe(true)
    // 父树被机制收口提交（主题可识别，不冒充 Agent 的提交）⇒ 现在是干净的。
    expect(corumGitStatusPorcelain(repo).trim()).toBe('')
    const subject = execFileSync('git', ['-C', repo, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()
    expect(subject).toContain('auto-commit before isolation')
    // 关键：子的分支基于**含父改动的 HEAD** ⇒ 子的树等于父的树（H1 的原始目标仍成立）。
    expect(existsSync(join(child.path, 'dirty.txt'))).toBe(true)
  })

  it('★ 配套②：既有仓库缺 `.corum-worktrees` ignore ⇒ 机制补齐并提交，第二次委派不被自家门拒', () => {
    const repo = makeRepo()
    // 复刻「用户既有仓库」：手动 init 的仓库没有机制写的那行 ignore。
    writeFileSync(join(repo, '.gitignore'), '# user ignore\n')
    corumGit(repo, ['add', '.gitignore'])
    corumGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-q', '-m', 'user ignore'])
    const orchestration = new CorumOrchestration(new Context())
    const first = orchestration.createWorktreeChild('session-2', repo)
    expect(existsSync(first.path)).toBe(true)
    // ignore 被机制写入并提交 ⇒ 父树不留 `?? .corum-worktrees/` ⇒ 第二次委派不被拒。
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.corum-worktrees/')
    expect(corumGitStatusPorcelain(repo).trim()).toBe('')
    const second = orchestration.createWorktreeChild('session-2', repo)
    expect(existsSync(second.path)).toBe(true)
  })

  it('干净父树且已 ignore ⇒ 建 worktree 不产生无谓提交（守卫不误伤）', () => {
    const repo = makeRepo()
    // 先让 ignore 就位并提交（模拟 corum 自己 init 的仓库 / 已跑过一次的仓库）。
    // 否则配套②会**合法地**补写并提交这行——那是「补齐缺口」，不是「无谓提交」。
    writeFileSync(join(repo, '.gitignore'), '.corum-worktrees/\n')
    corumGit(repo, ['add', '.gitignore'])
    corumGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-q', '-m', 'ignore worktrees'])
    const before = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const orchestration = new CorumOrchestration(new Context())
    const child = orchestration.createWorktreeChild('session-3', repo)
    expect(existsSync(child.path)).toBe(true)
    expect(child.branch.startsWith('wt/')).toBe(true)
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(before)
  })
})

describe('corumCommitWorktreeOnSettle — 收口强制提交（机制保证，不由 Agent 决定）', () => {
  it('未提交的 worktree ⇒ 被机制提交掉，且提交主题可识别', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo)
    writeFileSync(join(worktree, 'child-work.txt'), 'payload\n')
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)

    const failure = corumCommitWorktreeOnSettle(worktree, 'wt-guard01')

    expect(failure).toBeUndefined()
    // 「未提交」这一态必须被消灭 —— 这正是用户要的「机制保证」。
    expect(corumWorktreeHasUncommitted(worktree)).toBe(false)
    const subject = execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()
    expect(subject).toBe(CORUM_AUTO_COMMIT_SUBJECT)
    // 内容是**被提交**而不是被丢弃。
    const files = execFileSync('git', ['-C', worktree, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
    expect(files).toContain('child-work.txt')
  })

  it('untracked 新文件也被纳入提交（否则子的新源码会丢）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard02')
    writeFileSync(join(worktree, 'brand-new.ts'), 'export {}\n')
    expect(corumCommitWorktreeOnSettle(worktree, 'wt-guard02')).toBeUndefined()
    const tracked = execFileSync('git', ['-C', worktree, 'ls-files'], { encoding: 'utf8' })
    expect(tracked).toContain('brand-new.ts')
  })

  it('干净 worktree ⇒ 安全 no-op（不造空提交）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard03')
    const before = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(corumCommitWorktreeOnSettle(worktree, 'wt-guard03')).toBeUndefined()
    const after = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(after).toBe(before)
  })

  it('目录不存在 ⇒ 安全 no-op（已回收的条目不应报错）', () => {
    const repo = makeRepo()
    expect(corumCommitWorktreeOnSettle(join(repo, 'nope'), 'wt-gone')).toBeUndefined()
  })

  it('提交失败 ⇒ 返回**结构化原因**（供上层投递给模型，而不是静默丢）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard04')
    writeFileSync(join(worktree, 'x.txt'), 'x\n')
    // 制造必然失败：把 index 锁住（git commit 会拒绝）。
    writeFileSync(join(repo, '.git', 'worktrees', 'wt-guard04', 'index.lock'), '')
    const failure = corumCommitWorktreeOnSettle(worktree, 'wt-guard04')
    expect(failure).toBeDefined()
    expect(failure?.slug).toBe('wt-guard04')
    expect(failure?.path).toBe(worktree)
    expect(failure?.reason.length).toBeGreaterThan(0)
    // 现场必须保住：失败不等于丢工作。
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)
  })
})
