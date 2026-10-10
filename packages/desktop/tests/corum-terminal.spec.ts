/**
 * corum-terminal 平台 shell 分派测试（terminalShell 能力收进 electron/platform/ 后）。
 *
 * 覆盖：
 * - darwin / linux：`$SHELL` 未设置回退 `/bin/zsh` + `['-l']`；显式设置时尊重
 * - win32：pwsh → powershell → cmd 探测链；pwsh/powershell 用 `['-NoLogo']`，cmd 无参数
 * - create 在 pty.spawn 抛错时抛 `cannot spawn shell ${shell}: ${error}` 信封
 *
 * @module corum-desktop/corum-terminal.spec
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

vi.mock('@deepseek-ai/dsh-typert-protocol', () => ({
  TypertRemoteService: class {
    ctx: unknown
    constructor(ctx: unknown, _name: string) {
      this.ctx = ctx
    }
  },
  Remote: () => (_target: unknown, _key: string, desc: PropertyDescriptor) => desc,
}))

// 让 create 的平台选路可测：固定 terminalShell 返回 /bin/zsh + ['-l']，
// 不受测试机实际运行平台（win32 / linux）影响。
vi.mock('../src/electron/platform/index.ts', () => ({
  getPlatformModule: () => ({
    terminalShell: () => ({ shell: '/bin/zsh', args: ['-l'] }),
  }),
}))

import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import type { Context } from '@deepseek-ai/cordis'
import { darwinPlatform } from '../src/electron/platform/darwin'
import { linuxPlatform } from '../src/electron/platform/linux'
import { win32Platform } from '../src/electron/platform/win32'
import { CorumTerminalService } from '../src/host/corum-terminal'

/** 临时删除 SHELL（模拟「未设置」），结束后恢复。 */
function withShellUnset<T>(fn: () => T): T {
  const saved = process.env.SHELL
  delete process.env.SHELL
  try {
    return fn()
  } finally {
    if (saved !== undefined) process.env.SHELL = saved
  }
}

describe('terminalShell — 平台 shell 分派', () => {
  describe('darwin / linux', () => {
    it('SHELL 未设置时回退 /bin/zsh + -l', () => {
      withShellUnset(() => {
        expect(darwinPlatform.terminalShell()).toEqual({ shell: '/bin/zsh', args: ['-l'] })
        expect(linuxPlatform.terminalShell()).toEqual({ shell: '/bin/zsh', args: ['-l'] })
      })
    })

    it('SHELL 显式设置时尊重该设置', () => {
      vi.stubEnv('SHELL', '/bin/fish')
      expect(darwinPlatform.terminalShell()).toEqual({ shell: '/bin/fish', args: ['-l'] })
      expect(linuxPlatform.terminalShell()).toEqual({ shell: '/bin/fish', args: ['-l'] })
    })
  })

  describe('win32', () => {
    beforeEach(() => {
      vi.stubEnv('PATH', 'C:\\A;C:\\B')
    })

    it('找到 pwsh.exe 时优先用它 + -NoLogo', () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith('pwsh.exe'))
      const r = win32Platform.terminalShell()
      expect(r.shell).toBe('pwsh.exe')
      expect(r.args).toEqual(['-NoLogo'])
    })

    it('无 pwsh 时回落 powershell.exe + -NoLogo', () => {
      vi.mocked(existsSync).mockImplementation((p: unknown) => String(p).endsWith('powershell.exe'))
      const r = win32Platform.terminalShell()
      expect(r.shell).toBe('powershell.exe')
      expect(r.args).toEqual(['-NoLogo'])
    })

    it('两者都缺时回落 cmd.exe（无 -NoLogo 参数）', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      const r = win32Platform.terminalShell()
      expect(r.shell).toBe('cmd.exe')
      expect(r.args).toEqual([])
    })
  })
})

describe('CorumTerminalService.create — spawn 错误信封', () => {
  beforeEach(() => {
    vi.mocked(pty.spawn).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('pty.spawn 抛错时抛 cannot spawn shell <shell>: <error> 信封', async () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })
    const ctx = { emit: vi.fn() } as unknown as Context
    const svc = new CorumTerminalService(ctx)
    // getPlatformModule 已被 mock 固定返回 /bin/zsh（见文件头）
    await expect(svc.create()).rejects.toThrow(
      /cannot spawn shell \/bin\/zsh: Error: ENOENT: no such file or directory/,
    )
  })
})