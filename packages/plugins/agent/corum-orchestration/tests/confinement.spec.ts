/**
 * `@corum/corum-orchestration` 的**隔离写边界**单测（2026-09-22）。
 *
 * 由来：用户核对指挥模式 kimi 会话（`corum-task-ef3f751e`）时发现**硬隔离在
 * `danger-full-access` 下不成立**——隔离的第 2 层（fs 写沙箱）按档位开关，而档位是
 * 用户可覆盖的状态；实测同一个 brief 结构，`workspace-write` 派出的 worker 写主树
 * 报 EPERM（硬隔离生效），`danger-full-access` 派出的 worker 删掉 19 个 worktree 并对
 * 主树执行 `git -C <主树> merge --no-ff`。
 *
 * 修法 1+2（用户拍板）：
 *   ① 正交轴（`confinedSandbox`）——本文件不测（它在 corum-subagent 的 policy 捕获面）；
 *   ② 纵深防御门禁——**本文件测**：`confinementGuard` 的放行/拦截面。
 *
 * 本文件同时钉住那个**实测误报**：`echo '===a->b==='` 里的 `->` 曾被重定向正则当成
 * 重定向，导致一条纯只读命令被只读门禁拒绝（白烧一次往返）。
 */
import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  absolutePathsIn,
  confinementGuard,
  confinementTempRoots,
  confinementViolation,
  detectBashWrite,
  isPathInside,
  stripQuoted,
} from '../src/index.ts'

/** 一个稳定的「worktree 根」缓存（只在词法层用，不需要真建目录）。 */
const WORKTREE = '/repo/.corum-worktrees/wt-abc123'
/** 同一仓的**主树**（= 越界目标）。 */
const MAIN = '/repo'

describe('stripQuoted — 引号字面量必须先剥（实测误报的根因）', () => {
  it('★ 单引号里的 `->` 不再被当成重定向（会话 corum-task-ef3f751e 的原始误报）', () => {
    // 原命令（真实来自该会话 turn 4 step 5，被 read-only 门禁误拒）
    const command = "cd /repo; echo '===saveProfileRemote->persist callsite==='; grep -n 'x' f.ts"
    expect(detectBashWrite(command)).toBeUndefined()
  })

  it('剥引号后引号内容被清空、引号本身保留', () => {
    expect(stripQuoted("echo 'a>b' \"c>d\"")).toBe("echo '' \"\"")
  })

  it('引号外的重定向仍然照旧被识别（不因剥引号而漏判）', () => {
    expect(detectBashWrite("echo 'a>b' > /tmp/out")).toBe('shell redirection writes to a file')
  })

  it('内联解释器的写盘特征长在引号里，故必须用未剥引号的原文判定', () => {
    // 若错误地对剥完引号的文本做 INLINE_WRITE_PATTERNS 判定，这条会漏判
    expect(detectBashWrite(`node -e "require('fs').writeFileSync('a','b')"`)).toBe('inline script writes to a file')
  })
})

describe('detectBashWrite — 承继既有语义（只读门禁与写边界门禁共用这一份）', () => {
  const reads: readonly string[] = [
    'ls -la',
    'git log --oneline -5',
    'git status --porcelain',
    'git diff HEAD~1',
    'grep -n "rm " f.ts',
    'cat f.ts | head -20',
    'echo done 2>&1',
    'grep -rn foo . > /dev/null',
  ]
  for (const command of reads) {
    it(`放行只读：${command}`, () => {
      expect(detectBashWrite(command)).toBeUndefined()
    })
  }

  const writes: readonly string[] = [
    'echo hi > /tmp/x',
    'rm -rf build',
    'git commit -m x',
    'git merge other',
    'sed -i s/a/b/ f.ts',
    'pnpm install',
    'mkdir -p out',
  ]
  for (const command of writes) {
    it(`拦下写形态：${command}`, () => {
      expect(detectBashWrite(command)).toBeDefined()
    })
  }

  describe('★ 选项带取值的形态（改动前就存在的漏判，2026-09-22 一并修掉）', () => {
    // 原实现取「第二个词」当子命令，于是 `git -C <dir> merge` 的第二个词是 `-C`，
    // 判不出写形态 ⇒ 这条越界命令在只读门禁下**从未被拦过**。实测会话
    // corum-task-ef3f751e 的 worker 正是用 `git -C <主树> merge --no-ff` 把分支并进主树。
    const withOptions: readonly [string, string][] = [
      ['git -C <主树> 的 merge（实测那条）', 'git -C /repo merge --no-ff rescue/x -m m'],
      ['git --git-dir=<主树>/.git 的 commit', 'git --git-dir=/repo/.git commit -m x'],
      ['git --git-dir <主树>/.git 的 commit（分列）', 'git --git-dir /repo/.git commit -m x'],
      ['git -c k=v 的 merge', 'git -c core.pager=cat merge other'],
    ]
    for (const [label, command] of withOptions) {
      it(`拦下：${label}`, () => {
        expect(detectBashWrite(command)).toBeDefined()
      })
    }

    it('带选项的**只读** git 命令仍然放行（不误伤）', () => {
      expect(detectBashWrite('git -C /repo log --oneline -5')).toBeUndefined()
      expect(detectBashWrite('git --git-dir=/repo/.git status --porcelain')).toBeUndefined()
    })
  })
})

describe('isPathInside / absolutePathsIn — 词法边界判定', () => {
  it('等于是、其下是、兄弟前缀不是（`/repo-x` 不算在 `/repo` 内）', () => {
    // 判定本身是**词法**比较（`src/confinement.ts` 的 `isPathInside` 用 `path.sep` 拼前缀），
    // 且契约是「两个入参都已 resolve」⇒ 用例必须给平台原生的路径形态。
    // POSIX 下 `resolve('/repo') === '/repo'`（与改动前逐字等价），Windows 下是 `D:\repo`；
    // 硬编码的 `/repo/a/b` 在 Windows 上是「以 / 分隔 + 以 \ 为 sep」的混写，不是合法入参。
    const repo = resolve('/repo')
    expect(isPathInside(repo, repo)).toBe(true)
    expect(isPathInside(join(repo, 'a', 'b'), repo)).toBe(true)
    expect(isPathInside(`${repo}-x`, repo)).toBe(false)
  })

  it('提取独立参数、--opt=/abs、以及 `-C /abs` 形态的绝对路径', () => {
    // 提取出的值是 `path.resolve(raw)`（见 `absolutePathsIn` 的文档），故期望值也必须过同一
    // 次 resolve：POSIX 下 `resolve('/repo') === '/repo'`（与改动前逐字等价）。
    expect(absolutePathsIn('git -C /repo merge b')).toContain(resolve('/repo'))
    expect(absolutePathsIn('cp x --target=/repo/y')).toContain(resolve('/repo/y'))
    expect(absolutePathsIn('echo hi > /tmp/z')).toContain(resolve('/tmp/z'))
  })

  it('标记家目录简写（`~` 与 `$HOME`）', () => {
    expect(absolutePathsIn('cp x ~/f')).toContain('~')
    expect(absolutePathsIn('cp x $HOME/f')).toContain('~')
  })

  it('相对路径不参与判定（子会话 cwd 就是 worktree，相对路径天然在界内）', () => {
    expect(absolutePathsIn('echo hi > out.txt')).toEqual([])
  })

  // P3 回归：POSIX 上 `//server/share` 是相对路径（`//` 非合法 UNC），UNC 提取须 win32 门控，
  // 不得进入写目标候选集（与 POSIX 正则 `!raw.startsWith('//')` 口径一致）。
  it.skipIf(process.platform === 'win32')('POSIX 上 //server/share 不被当 UNC 提取', () => {
    expect(absolutePathsIn('rm -rf //server/share/x')).toEqual([])
  })
})

describe('confinementGuard — 隔离子会话的写边界（修法 2）', () => {
  const guard = confinementGuard({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN })
  const bash = (command: string) => ({ name: 'bash', arguments: { command } })

  describe('变异工具：路径参数越界即拒', () => {
    it('★ 写主树被拒（这就是实测里 worker 干成的那件事）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${MAIN}/packages/x.ts`, content: 'x' } })).toBeDefined()
    })

    it('★ edit / str_replace_editor 同样受约束（两个工具的参数名不同，都要覆盖）', () => {
      expect(guard({ name: 'edit', arguments: { file_path: `${MAIN}/a.ts`, old_string: 'a', new_string: 'b' } })).toBeDefined()
      expect(guard({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: `${MAIN}/a.ts`, old_str: 'a', new_str: 'b' } })).toBeDefined()
    })

    it('worktree 内的相对路径与绝对路径都放行', () => {
      expect(guard({ name: 'write', arguments: { file_path: 'src/a.ts', content: 'x' } })).toBeUndefined()
      expect(guard({ name: 'write', arguments: { file_path: `${WORKTREE}/src/a.ts`, content: 'x' } })).toBeUndefined()
    })

    it('★ 兄弟 worktree 也算越界（隔离是「自己的壳」，不是「所有壳」）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${MAIN}/.corum-worktrees/wt-other/f.ts`, content: 'x' } })).toBeDefined()
    })
  })

  describe('shell：只读一律放行，写形态才审越界', () => {
    it('★ `git -C <主树> merge` 被拒（实测里 worker 干成的第二件事）', () => {
      expect(guard(bash(`git -C ${MAIN} merge --no-ff rescue/x -m m`))).toBeDefined()
    })

    it('★ `rm -rf <主树>/.corum-worktrees/wt-*` 被拒（实测里 worker 删掉 19 个 worktree 的命令）', () => {
      expect(guard(bash(`rm -rf ${MAIN}/.corum-worktrees/wt-16fd74`))).toBeDefined()
    })

    it('★ worktree 外的重定向被拒', () => {
      expect(guard(bash(`echo hi > ${MAIN}/f.txt`))).toBeDefined()
    })

    it('★ 越界的家目录简写被拒', () => {
      expect(guard(bash('cp a ~/.corum/settings.yaml'))).toBeDefined()
    })

    it('只读命令放行——隔离**不**限制读（通知里明说 reads are still allowed）', () => {
      expect(guard(bash('git log --oneline -5'))).toBeUndefined()
      expect(guard(bash(`git -C ${MAIN} log --oneline -3`))).toBeUndefined()
      expect(guard(bash(`grep -rn foo ${MAIN}/packages | head`))).toBeUndefined()
    })

    it('worktree 内的写与提交放行（子 Agent 必须能在自己分支提交）', () => {
      expect(guard(bash('echo hi > out.txt'))).toBeUndefined()
      expect(guard(bash('git add -A && git commit -m x'))).toBeUndefined()
      expect(guard(bash(`echo hi > ${WORKTREE}/out.txt`))).toBeUndefined()
    })

    it('★ 临时区放行（/tmp 造 fixture 是 build/test 的常见需要，与官方可写根口径一致）', () => {
      expect(guard(bash('echo hi > /tmp/fixture.txt'))).toBeUndefined()
    })
  })

  describe('其它工具：不表态（abstain），不干扰机制自身的收尾', () => {
    it('read / grep / glob / send_message 一律放行', () => {
      for (const name of ['read', 'grep', 'glob', 'send_message', 'todo_write']) {
        expect(guard({ name, arguments: { path: `${MAIN}/x` } })).toBeUndefined()
      }
    })

    it('参数缺失或形态不符时不误判（宁可漏判也不误伤）', () => {
      expect(guard({ name: 'bash', arguments: {} })).toBeUndefined()
      expect(guard({ name: 'write', arguments: {} })).toBeUndefined()
      expect(guard({ name: 'bash', arguments: { command: 42 } })).toBeUndefined()
    })
  })

  describe('临时区允许集', () => {
    it('至少含一个临时根，且已 resolve 去重', () => {
      const roots = confinementTempRoots()
      expect(roots.length).toBeGreaterThan(0)
      // fork（corum）win32 适配（P0-2）：POSIX 含 /tmp 与 tmpdir()；
      // win32 只含 tmpdir()（丢弃 path.resolve('/tmp') 伪根——win32 上解析为当前盘符下 \tmp）。
      if (process.platform !== 'win32') {
        expect(roots).toContain(resolve('/tmp'))
      }
      expect(roots).toContain(resolve(tmpdir()))
      expect(new Set(roots).size).toBe(roots.length)
    })
  })

  describe('★ 工作区落在临时区之内时仍须保护（本轮自查发现的弱点）', () => {
    // 由来：允许集含 /tmp 与 tmpdir()（造 fixture 的合法需要），但**工作区本身**可能就建在
    // 临时区里（本仓测试环境、以及用户把 workspace 放在 /tmp 的场景）。彼时若只按
    // 「worktree 之外都拦」，主树会因落在临时区允许集里而被放行 ⇒ 门禁等于没装。
    // 修法：`parentTreeRoot` **拒绝优先于允许**。
    const tempBase = '/tmp/corum-ws'                      // 落在临时区内的主树
    const wt = `${tempBase}/.corum-worktrees/wt-x`
    const guard = confinementGuard({ worktreeRoot: wt, parentTreeRoot: tempBase })

    it('★ 主树在 /tmp 下也照样被拒（不被临时区允许集吞掉）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${tempBase}/main.ts`, content: 'x' } })).toBeDefined()
      expect(guard({ name: 'bash', arguments: { command: `rm -rf ${tempBase}/.corum-worktrees/wt-16fd74` } })).toBeDefined()
      expect(guard({ name: 'bash', arguments: { command: `git -C ${tempBase} merge x` } })).toBeDefined()
    })

    it('worktree 自身与 /tmp 其它位置仍放行（不因新规则误伤）', () => {
      expect(guard({ name: 'write', arguments: { file_path: `${wt}/f.ts`, content: 'x' } })).toBeUndefined()
      expect(guard({ name: 'bash', arguments: { command: 'echo hi > /tmp/other-fixture.txt' } })).toBeUndefined()
    })
  })

  describe('真目录端到端（不是纯字符串）', () => {
    // ⚠️ 必须建在**临时区之外**：`/tmp` 与 `tmpdir()` 属于允许集（造 fixture 的合法
    // 需要），用 mkdtempSync 建的「主树」会落在允许集里 ⇒ 这条断言测不出东西
    // （首版就是这么写的，被自己抓到）。这里用仓库内的相对落点并只做纯词法判定，
    // 不依赖真实仓库结构。
    const base = join(process.cwd(), '.corum-confinement-spec-main')
    const wt = join(base, '.corum-worktrees', 'wt-real')
    const realGuard = confinementGuard({ worktreeRoot: wt, parentTreeRoot: base })

    it('★ 真建 worktree 与主树两个目录：主树文件被拒、worktree 文件放行', () => {
      // 主树路径（base，不是 wt）应被拒——注意 tmpdir 在允许集内，故这个 base 必须不在其中
      expect(realGuard({ name: 'write', arguments: { file_path: join(base, 'main-tree.ts'), content: 'x' } })).toBeDefined()
      // worktree 内应放行
      expect(realGuard({ name: 'write', arguments: { file_path: join(wt, 'f.ts'), content: 'x' } })).toBeUndefined()
    })

    // fork（corum）win32 适配（P0-2）转正：absolutePathsIn 已增补盘符/UNC 路径提取，
    // win32 上 `join()` 产出的主树 `D:\2026.2.6\…` 现在会被盘符正则提取 ⇒ 越界判定生效。
    // 两个平台都跑（参数化平台：POSIX 走 `/abs` 正则，win32 走盘符正则）。
    it('★ git -C 指向主树同样被拒（端到端复刻实测里那条 merge 命令）', () => {
      expect(realGuard({ name: 'bash', arguments: { command: `git -C ${base} merge x` } })).toBeDefined()
    })
  })
})

/**
 * 2026-09-27 用户裁定的两轴口径：**隔离 = 工作区隔离**（防并发改写互相踩），与「能不能碰
 * 仓外的东西」是两条正交的轴。因此：
 *   · 主仓（含共享 `.git` / 其它分支 / 其它 worktree）⇒ 硬拒，**不可提权获得**；
 *   · 主仓**之外**（另一个仓、系统路径……）⇒ 门禁**弃权**，交沙箱 + 审批（**可提权**）。
 * 本组用例同时钉住两处实测漏判：`cd <主仓>` 开头（会话 corum-task-56b7d485 三条越界命令
 * 全都这么写）与「无绝对路径的仓库级写」（01:11:30 那条 `git worktree remove` + `git branch -D`）。
 */
describe('★ 两轴口径（2026-09-27 用户裁定）：主仓硬线 vs 仓外交权限层', () => {
  const guard = confinementGuard({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN })
  const bash = (command: string) => ({ name: 'bash', arguments: { command } })

  describe('T1：主仓**之外**的目标弃权（门禁不管，交权限层 ⇒ 可提权）', () => {
    // 由来：本场任务要把产物落到**另一个仓** `/Users/kukucai/work/Corum-Harness-Project`。
    // 旧口径把「worktree 之外」一律硬拒 ⇒ 子 Agent 带 danger-full-access 重试两次仍被
    // 同一句驳回，机制只能把搬运外包给用户。这类目标属于权限轴，门禁必须放手。
    const outside = [
      'mkdir -p /Users/kukucai/work/Corum-Harness-Project/packages/corum-project',
      'mv /repo/.corum-worktrees/wt-abc123/Corum-Harness-Project /Users/kukucai/work/Corum-Harness-Project',
      'rsync -a --delete /repo/.corum-worktrees/wt-abc123/Corum-Harness-Project/ /Users/kukucai/work/Corum-Harness-Project/',
    ]
    for (const command of outside) {
      it(`弃权（不再硬拒）：${command.slice(0, 52)}…`, () => {
        expect(guard(bash(command))).toBeUndefined()
        expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('outside')
      })
    }

    it('变异工具写仓外路径同样弃权（交沙箱判定）', () => {
      const call = { name: 'write', arguments: { file_path: '/Users/kukucai/work/Corum-Harness-Project/package.json', content: '{}' } }
      expect(guard(call)).toBeUndefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, call)?.kind).toBe('outside')
    })

    it('仓外的只读命令与临时区照旧不表态', () => {
      expect(guard(bash('cd /tmp/scratch && echo hi > f.txt'))).toBeUndefined()
      expect(guard(bash('git -C /Users/kukucai/work/Corum-Harness-Project log --oneline -3'))).toBeUndefined()
    })
  })

  describe('T2a：`cd <主仓>` 本身即越界（它让后续相对路径写全落在主仓里）', () => {
    it('★ 实测那三条命令的开头（cd 主仓 + 相对路径 git worktree remove）', () => {
      expect(guard(bash(`cd ${MAIN} && git worktree remove --force .corum-worktrees/wt-471e5f`))).toBeDefined()
      expect(guard(bash(`cwd=$(pwd); cd ${MAIN} && git worktree remove --force .corum-worktrees/wt-471e5f`))).toBeDefined()
    })

    it('★ `cd ../..` 穿越到主仓同样被拒（不含任何绝对路径）', () => {
      expect(guard(bash('cd ../.. && rm -rf packages/plugins/agent/corum-agent/src/project.ts'))).toBeDefined()
      expect(guard(bash('cd .. && echo hi > main-tree-file.txt'))).toBeDefined()
    })

    it('子 shell 形态 `(cd <主仓> && …)` 也认得出', () => {
      expect(guard(bash(`(cd ${MAIN} && git commit -m x)`))).toBeDefined()
    })
  })

  describe('T2a：无绝对路径的**仓库级写**（共享 .git）硬拒', () => {
    const repoGlobal = [
      'git worktree remove --force .corum-worktrees/wt-471e5f',
      'git branch -D wt/wt-471e5f',
      'git branch new-branch',
      'git push origin main',
      'git fetch origin',
      'git tag v1.0.0',
      'git config user.name kukucaiCndy',
      'git remote add origin https://example.com/x.git',
      'git update-ref refs/heads/main HEAD~1',
      'git symbolic-ref HEAD refs/heads/other',
      'git submodule add https://example.com/x.git vendor/x',
      'git notes add -m x',
      'git reflog expire --expire=now --all',
      'git gc --prune=now',
      'git config --global user.name x',
      'git replace -d abc123',
      // 合并短开关里**含写**的组合仍然是写（别把 `-avv` 的豁免搞成对所有 `-xxx` 放行）。
      'git branch -dav',
      'git branch -Davv',
    ]
    for (const command of repoGlobal) {
      it(`拒：${command}`, () => {
        expect(guard(bash(command))).toBeDefined()
        expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('parent-tree')
      })
    }

    // 裁定的另一半是「**可读**」——只读形态必须继续放行，否则子 Agent 连自己所在仓库的
    // 分支列表、配置都读不到（本仓自己的 brief 纪律就要它们读这些）。
    const reads = [
      'git worktree list',
      `git -C ${MAIN} worktree list`,
      'git branch --list',
      `git -C ${MAIN} branch -a`,
      'git branch',
      'git config --get user.name',
      'git config -l',
      `git -C ${MAIN} remote -v`,
      'git tag -l',
      'git submodule status',
      'git notes show',
      'git reflog show',
      'git symbolic-ref HEAD',
      `git -C ${MAIN} symbolic-ref HEAD`,
      'git bisect log',
      // 自查到的**误伤面**（2026-09-27）：这些无 flag 的读法在只读门禁下极常用
      // （指挥模式主 Agent 的只读 shell / 研究子会话），把它们当写会白烧往返。
      'git config user.email',
      'git config --global user.email',
      `git -C ${MAIN} config user.email`,
      'git worktree',
      'git submodule',
      'git replace -l',
      'git bisect',
      'git branch --show-current',
      `git -C ${MAIN} remote show origin`,
      // 2026-09-27 实机误伤：隔离子会话按 brief 跑 `git branch -avv` 被硬拒——只读正则按整
      // token 匹配 `-a`/`-vv`，而 git 的短开关**可以合并**。凡「读+读」组合都该放行。
      'git branch -avv',
      `git -C ${MAIN} branch -avv`,
      'git branch -rv',
      'git branch -vvv',
      'git tag -l -n5',
    ]
    for (const command of reads) {
      it(`放行只读：${command}`, () => {
        expect(guard(bash(command))).toBeUndefined()
      })
    }

    it('detectBashWrite 同步认这些仓库级写（只读门禁也共用同一份判定）', () => {
      expect(detectBashWrite('git worktree remove --force x')).toBeDefined()
      expect(detectBashWrite('git branch -D x')).toBeDefined()
      expect(detectBashWrite('git -C /repo branch --list')).toBeUndefined()
      expect(detectBashWrite('git config --get user.name')).toBeUndefined()
    })
  })

  describe('T5 配套：worktree 内的**独立仓**不被当主仓写（用户裁定它是独立产物）', () => {
    it('在原位建嵌套仓放行（相对路径落在自己 worktree 内）', () => {
      expect(guard(bash('git init Corum-Harness-Project'))).toBeUndefined()
      expect(guard(bash('git init && git add -A && git commit -m skeleton'))).toBeUndefined()
    })

    it('★ `cd` 进 worktree 的子孙目录后操作那个仓的 config 不判主仓', () => {
      // 实测形态：子会话在自己的 worktree 里建闭源仓并设 git 身份。
      expect(guard(bash('cd Corum-Harness-Project && git config user.name "kukucaiCndy" && git add -A && git commit -m x'))).toBeUndefined()
    })

    it('但 `git config` 不 cd 就仍按主仓硬线处理（它打的是共享 .git/config）', () => {
      expect(guard(bash('git config user.name x'))).toBeDefined()
    })
  })

  describe('多目标命令按**最严**判定（否则 `cp 仓外 主仓` 会变成可提权）', () => {
    it('★ 同时含仓外与主仓目标 ⇒ parent-tree', () => {
      const command = `cp /Users/kukucai/elsewhere/x.ts ${MAIN}/packages/x.ts`
      expect(guard(bash(command))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('parent-tree')
    })

    it('全部是仓外目标 ⇒ outside（不被最严规则误伤）', () => {
      const command = 'cp /Users/kukucai/a/x.ts /Users/kukucai/b/x.ts'
      expect(guard(bash(command))).toBeUndefined()
      expect(confinementViolation({ worktreeRoot: WORKTREE, parentTreeRoot: MAIN }, bash(command))?.kind).toBe('outside')
    })
  })
})
/**
 * fork（corum）win32 适配（P0-2，安全面）：隔离写门禁的 win32 路径提取专例。
 *
 * 由来：`absolutePathsIn` 旧正则只覆盖 POSIX `/abs`，win32 上 `D:\target`、`C:/target`、
 * `\\server\share\target` 均漏判 ⇒ `git -C D:\主仓 …` 越界写被放行。本组用例钉死三处
 * 同源缺口的修复：absolutePathsIn 提取、cdTargetsOf 绝对判定、confinementTempRoots 允许集。
 *
 * **安全红线**：漏判优先于误判 —— 对主仓之外的写目标不得放行。
 *
 * win32 专例用 `skipIf(!isWin32)` 限定：POSIX 上这些路径形态不存在（`D:\…` 被当相对路径，
 * `\\server\share` 被当转义），强行跑会因 `path.resolve` 语义差异而假红。
 */
describe('★ win32 路径提取（P0-2，安全面）', () => {
  const isWin32 = process.platform === 'win32'

  describe('absolutePathsIn — win32 盘符/UNC 路径提取', () => {
    it.skipIf(!isWin32)('提取盘符路径 D:\\越界\\path（反斜杠）', () => {
      expect(absolutePathsIn('rm -rf D:\\outside\\path')).toContain(resolve('D:\\outside\\path'))
    })

    it.skipIf(!isWin32)('提取盘符路径 C:/越界/path（正斜杠）', () => {
      expect(absolutePathsIn('rm -rf C:/outside/path')).toContain(resolve('C:/outside/path'))
    })

    it.skipIf(!isWin32)('提取 UNC 路径 \\\\server\\share\\越界', () => {
      expect(absolutePathsIn('rm -rf \\\\server\\share\\outside')).toContain(resolve('\\\\server\\share\\outside'))
    })

    it.skipIf(!isWin32)('提取 --opt=D:\\abs 形态（盘符路径赋值）', () => {
      expect(absolutePathsIn('cp x --target=D:\\outside\\y')).toContain(resolve('D:\\outside\\y'))
    })

    it.skipIf(!isWin32)('提取引号内的盘符路径（pwsh 命令文本）', () => {
      expect(absolutePathsIn('rm -rf "D:\\outside\\path"')).toContain(resolve('D:\\outside\\path'))
    })

    it.skipIf(!isWin32)('提取 / 与 \\ 混写的盘符路径', () => {
      // D:\\corum-test-main/packages\\x.ts —— 混写分隔符，path.resolve 在 win32 上正确归一
      expect(absolutePathsIn('rm -rf D:\\corum-test-main/packages\\x.ts')).toContain(resolve('D:\\corum-test-main/packages\\x.ts'))
    })

    it.skipIf(!isWin32)('POSIX 路径仍被提取（不因 win32 增补而漏掉 POSIX 分支）', () => {
      expect(absolutePathsIn('rm -rf /tmp/x')).toContain(resolve('/tmp/x'))
    })

    // P1 回归：重定向目标 `>D:\path` 旧正则前缀缺 `>`，写操作逃逸硬拒。
    it.skipIf(!isWin32)('提取重定向目标 >D:\\path（`>` 紧贴盘符，无空格）', () => {
      expect(absolutePathsIn('echo hi >D:\\main\\x')).toContain(resolve('D:\\main\\x'))
    })

    it.skipIf(!isWin32)('提取重定向目标 >>D:\\path / 2>D:\\path（覆盖各重定向形态）', () => {
      expect(absolutePathsIn('echo hi >>D:\\main\\x')).toContain(resolve('D:\\main\\x'))
      expect(absolutePathsIn('echo hi 2>D:\\main\\x')).toContain(resolve('D:\\main\\x'))
    })

    // P1 回归：含空格的引号路径旧正则在空格处截断（只提取 `D:\\my`），越界写漏判。
    it.skipIf(!isWin32)('提取引号内含空格的盘符路径（不在空格处截断）', () => {
      expect(absolutePathsIn('rm -rf "D:\\my path\\x"')).toContain(resolve('D:\\my path\\x'))
      expect(absolutePathsIn("rm -rf 'D:\\my path\\x'")).toContain(resolve('D:\\my path\\x'))
    })
  })

  describe('confinementGuard — win32 越界写硬拒（安全红线：漏判优先于误判）', () => {
    // 纯词法判定，不需要真建目录。主仓与 worktree 都用 win32 盘符路径。
    // 越界 = 主仓之内、worktree 之外（parent-tree，硬拒）；主仓之外是 outside（弃权）。
    const winMain = 'D:\\corum-test-main'
    const winWt = 'D:\\corum-test-main\\.corum-worktrees\\wt-x'
    const guard = confinementGuard({ worktreeRoot: winWt, parentTreeRoot: winMain })
    const bash = (command: string) => ({ name: 'bash', arguments: { command } })
    const pwsh = (command: string) => ({ name: 'pwsh', arguments: { command } })

    it.skipIf(!isWin32)('★ 命令含 D:\\主仓\\packages\\x.ts 显式写路径被提取并拒（parent-tree）', () => {
      expect(guard(bash(`rm -rf ${winMain}\\packages\\x.ts`))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: winWt, parentTreeRoot: winMain }, bash(`rm -rf ${winMain}\\packages\\x.ts`))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ 命令含 C:/主仓/packages/x.ts 显式写路径被提取并拒（C: 盘符正斜杠）', () => {
      const cMain = 'C:/corum-test-main'
      const cWt = 'C:/corum-test-main/.corum-worktrees/wt-x'
      const g = confinementGuard({ worktreeRoot: cWt, parentTreeRoot: cMain })
      expect(g(bash('rm -rf C:/corum-test-main/packages/x.ts'))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: cWt, parentTreeRoot: cMain }, bash('rm -rf C:/corum-test-main/packages/x.ts'))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ 命令含 \\\\server\\share\\主仓\\packages UNC 写路径被提取并拒', () => {
      const uncMain = '\\\\server\\share\\main'
      const uncWt = '\\\\server\\share\\main\\.corum-worktrees\\wt-x'
      const g = confinementGuard({ worktreeRoot: uncWt, parentTreeRoot: uncMain })
      expect(g(bash('rm -rf \\\\server\\share\\main\\packages\\x.ts'))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: uncWt, parentTreeRoot: uncMain }, bash('rm -rf \\\\server\\share\\main\\packages\\x.ts'))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ git -C D:\\主仓 merge 被拒（win32 端到端复刻实测那条）', () => {
      expect(guard(bash(`git -C ${winMain} merge x`))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: winWt, parentTreeRoot: winMain }, bash(`git -C ${winMain} merge x`))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ pwsh 命令同样受约束（rm 是 pwsh 里 Remove-Item 别名，detectBashWrite 认识）', () => {
      expect(guard(pwsh(`rm -rf ${winMain}\\packages\\x.ts`))).toBeDefined()
    })

    it.skipIf(!isWin32)('★ / 与 \\ 混写的越界写路径被拒', () => {
      // D:\\corum-test-main/packages\\x.ts —— 混写分隔符，落在主仓内 ⇒ parent-tree
      expect(guard(bash('rm -rf D:\\corum-test-main/packages\\x.ts'))).toBeDefined()
    })

    it.skipIf(!isWin32)('★ 主仓之外的写目标弃权（outside，不硬拒——两轴口径）', () => {
      // D:\\outside 在主仓之外 ⇒ outside（门禁弃权，交权限层）。验证不误伤。
      expect(guard(bash('rm -rf D:\\outside\\path'))).toBeUndefined()
      expect(confinementViolation({ worktreeRoot: winWt, parentTreeRoot: winMain }, bash('rm -rf D:\\outside\\path'))?.kind).toBe('outside')
    })
  })

  describe('cdTargetsOf — win32 绝对路径判定（cd D:\\主仓 后相对写以主仓为 cwd）', () => {
    const winMain = 'D:\\corum-test-main'
    const winWt = 'D:\\corum-test-main\\.corum-worktrees\\wt-x'
    const guard = confinementGuard({ worktreeRoot: winWt, parentTreeRoot: winMain })
    const bash = (command: string) => ({ name: 'bash', arguments: { command } })

    it.skipIf(!isWin32)('★ cd D:\\主仓 后相对写路径以主仓为 cwd 解析，越界判定不失真', () => {
      // cd 到主仓后，rm 的相对路径 packages/x.ts 落在主仓里 ⇒ cd 目标本身即越界
      expect(guard(bash(`cd ${winMain} && rm -rf packages/x.ts`))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: winWt, parentTreeRoot: winMain }, bash(`cd ${winMain} && rm -rf packages/x.ts`))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ cd C:/主仓（正斜杠盘符）同样被判为绝对路径', () => {
      const mainFwd = 'C:/corum-test-main'
      const wtFwd = 'C:/corum-test-main/.corum-worktrees/wt-x'
      const g = confinementGuard({ worktreeRoot: wtFwd, parentTreeRoot: mainFwd })
      expect(g(bash(`cd ${mainFwd} && rm -rf x.ts`))).toBeDefined()
    })

    it.skipIf(!isWin32)('★ cd \\\\server\\share\\主仓（UNC）被判为绝对路径', () => {
      const mainUnc = '\\\\server\\share\\main'
      const wtUnc = '\\\\server\\share\\main\\.corum-worktrees\\wt-x'
      const g = confinementGuard({ worktreeRoot: wtUnc, parentTreeRoot: mainUnc })
      expect(g(bash(`cd ${mainUnc} && rm -rf x.ts`))).toBeDefined()
    })
  })

  describe('拒绝优先于允许（安全红线：写目标同时匹配允许集与拒绝集时判为硬拒）', () => {
    it.skipIf(!isWin32)('★ 主仓落在 tmpdir() 之内时仍被拒（拒绝优先于允许集）', () => {
      // 构造：主仓落在 tmpdir() 之内（允许集），但写目标是 parent-tree ⇒ 拒绝优先
      const tmp = resolve(tmpdir())
      const mainInTmp = join(tmp, 'corum-win32-reject-priority')
      const wtInTmp = join(mainInTmp, '.corum-worktrees', 'wt-x')
      const g = confinementGuard({ worktreeRoot: wtInTmp, parentTreeRoot: mainInTmp })
      // 变异工具写主仓 ⇒ parent-tree（即便主仓在 tmpdir 允许集内）
      expect(g({ name: 'write', arguments: { file_path: join(mainInTmp, 'f.ts'), content: 'x' } })).toBeDefined()
      // bash 写主仓同样拒绝
      expect(g({ name: 'bash', arguments: { command: `rm -rf ${join(mainInTmp, 'x.ts')}` } })).toBeDefined()
    })
  })

  describe('confinementTempRoots — win32 临时区允许集（不含 /tmp 伪根）', () => {
    it.skipIf(!isWin32)('★ win32 只含 tmpdir()，不含 path.resolve("/tmp") 伪根', () => {
      const roots = confinementTempRoots()
      expect(roots).toContain(resolve(tmpdir()))
      // win32 上 path.resolve('/tmp') 解析为当前盘符下 \tmp（伪根），不应在允许集里
      const pseudoRoot = resolve('/tmp')
      // 只有当伪根与 tmpdir 不同时才断言不含（避免 tmpdir 恰好是 \tmp 的极端情况）
      if (pseudoRoot !== resolve(tmpdir())) {
        expect(roots).not.toContain(pseudoRoot)
      }
      // 允许集去重
      expect(new Set(roots).size).toBe(roots.length)
    })
  })

  describe('安全红线：对主仓越界写不得放行（漏判优先级高于误判）', () => {
    // 钉死安全红线：各种 win32 形态的越界写都必须被提取并纳入判定，不得漏判放行。
    const winMain = 'D:\\corum-test-main'
    const winWt = 'D:\\corum-test-main\\.corum-worktrees\\wt-x'
    const guard = confinementGuard({ worktreeRoot: winWt, parentTreeRoot: winMain })
    const bash = (command: string) => ({ name: 'bash', arguments: { command } })

    it.skipIf(!isWin32)('★ 重定向到主仓内文件被拒', () => {
      expect(guard(bash(`echo hi > ${winMain}\\f.txt`))).toBeDefined()
    })

    it.skipIf(!isWin32)('★ cp 仓外到主仓被拒（多目标按最严判定）', () => {
      expect(guard(bash(`cp D:\\outside\\x.ts ${winMain}\\packages\\x.ts`))).toBeDefined()
      expect(confinementViolation({ worktreeRoot: winWt, parentTreeRoot: winMain }, bash(`cp D:\\outside\\x.ts ${winMain}\\packages\\x.ts`))?.kind).toBe('parent-tree')
    })

    it.skipIf(!isWin32)('★ rm -rf 主仓的 worktree 目录被拒', () => {
      expect(guard(bash(`rm -rf ${winMain}\\.corum-worktrees\\wt-other`))).toBeDefined()
    })

    it.skipIf(!isWin32)('★ git -C 主仓 worktree remove 被拒（仓库级写 + 绝对路径）', () => {
      expect(guard(bash(`git -C ${winMain} worktree remove --force .corum-worktrees/wt-471e5f`))).toBeDefined()
    })
  })
})
