/**
 * 工作区身份归一 win32 字形兜底测试（P0-3）。
 *
 * 修复 `canonicalWorkspaceKey` 盘符大小写未归一导致身份失真：
 *   - `d:\work\foo` 与 `D:\work\foo` 须产出同一身份键；
 *   - 尾斜杠 / 分隔符混写须归一；
 *   - POSIX 路径归一行为不被 win32 分支污染。
 *
 * 通过 mock `realpathSync` 强制走字形兜底分支（模拟目录不可达），
 * 并 mock `process.platform` 在任意宿主平台上验证目标平台分支——
 * 这样 POSIX CI 也能守住 win32 分支的正确性。
 *
 * @module corum-agent/workspace-identity-win32.spec
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalWorkspaceKey } from '../src/workspace-identity.ts'

// 强制 realpathSync 抛错 → 走字形兜底分支（测的就是兜底归一逻辑）。
// 其余 fs 导出保留原实现（canonicalWorkspaceKey 在兜底分支不调其他 fs 函数）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    realpathSync: () => {
      throw new Error('ENOENT: mocked — force canonical fallback')
    },
  }
})

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

// ── win32 字形兜底（P0-3 盘符大小写归一）────────────────────────────────

describe('canonicalWorkspaceKey win32 字形兜底（P0-3 盘符大小写归一）', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
  })

  it('盘符大小写归一：d:\\work\\foo 与 D:\\work\\foo 产出同一身份键', () => {
    const lower = canonicalWorkspaceKey('d:\\work\\foo')
    const upper = canonicalWorkspaceKey('D:\\work\\foo')
    expect(lower).toBeDefined()
    expect(lower).toBe(upper)
    expect(lower).toBe('D:\\work\\foo')
  })

  it('尾斜杠归一：D:\\work\\foo\\ 与 D:\\work\\foo 产出同一身份键', () => {
    const withSlash = canonicalWorkspaceKey('D:\\work\\foo\\')
    const noSlash = canonicalWorkspaceKey('D:\\work\\foo')
    expect(withSlash).toBe(noSlash)
    expect(withSlash).toBe('D:\\work\\foo')
  })

  it('分隔符混写归一：D:/work\\foo 与 D:\\work\\foo 产出同一身份键', () => {
    const mixed = canonicalWorkspaceKey('D:/work\\foo')
    const canonical = canonicalWorkspaceKey('D:\\work\\foo')
    expect(mixed).toBe(canonical)
    expect(mixed).toBe('D:\\work\\foo')
  })

  it('幂等：归一后再归一仍不变（f(f(cwd)) === f(cwd)）', () => {
    const cwd = 'd:\\projects\\corum'
    const a = canonicalWorkspaceKey(cwd)!
    const b = canonicalWorkspaceKey(a)!
    const c = canonicalWorkspaceKey(b)!
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('盘符根保留：D:\\ 不被去尾分隔符破坏', () => {
    expect(canonicalWorkspaceKey('D:\\')).toBe('D:\\')
    expect(canonicalWorkspaceKey('d:\\')).toBe('D:\\')
  })

  it('空与空白返回 undefined（不抛异常）', () => {
    expect(canonicalWorkspaceKey(undefined)).toBeUndefined()
    expect(canonicalWorkspaceKey('')).toBeUndefined()
    expect(canonicalWorkspaceKey('   ')).toBeUndefined()
  })
})

// ── POSIX 不污染（平台分支不改变 POSIX 归一行为）──────────────────────────
//
// POSIX 分支用 `normalize`（平台默认 import），只有在 POSIX 宿主上才是
// `path.posix.normalize`。故这些用例在 win32 宿主上跳过——win32 分支由上面的
// mock-platform 专例覆盖，POSIX 分支由 POSIX CI（macos/ubuntu）覆盖。
// 这与 AGENTS.md 的平台策略一致：CI 在 macos-latest、ubuntu-latest、windows-latest
// 三平台跑全量；本块在 win32 宿主上 skip 是产品事实（win32 宿主 import 的 normalize
// 是 path.win32.normalize，对 POSIX 尾斜杠归一语义不同），不是测试写法问题。

describe.skipIf(process.platform === 'win32')(
  'canonicalWorkspaceKey POSIX 字形兜底（平台分支不污染 POSIX）',
  () => {
    it('POSIX 尾斜杠归一：/home/user/ 与 /home/user 产出同一身份键', () => {
      expect(canonicalWorkspaceKey('/home/user/')).toBe('/home/user')
      expect(canonicalWorkspaceKey('/home/user')).toBe('/home/user')
    })

    it('POSIX 根保留：/ 不被去尾', () => {
      expect(canonicalWorkspaceKey('/')).toBe('/')
    })

    it('POSIX 路径不被 win32 盘符归一逻辑污染', () => {
      // 形似盘符的 POSIX 路径不应被 win32 分支误处理
      expect(canonicalWorkspaceKey('/d/work/foo')).toBe('/d/work/foo')
    })

    it('幂等：同一 POSIX 工作目录多次归一产出同一身份键', () => {
      const cwd = '/home/user/projects/corum'
      expect(canonicalWorkspaceKey(cwd)).toBe(canonicalWorkspaceKey(cwd))
    })
  },
)