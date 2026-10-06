/**
 * corum-terminal 平台 shell 分派测试（任务 5.2）。
 *
 * 覆盖：
 * - win32：SHELL 未设置时回退 pwsh.exe/powershell.exe + `['-NoLogo']`，不含 POSIX `-l`
 * - win32：SHELL 显式设置时尊重该设置
 * - POSIX：SHELL 未设置时回退 `/bin/zsh` + `['-l']`（行为与适配前一致）
 * - POSIX：SHELL 显式设置时尊重
 * - SHELL 空串/纯空白视为未设置
 * - create 在 pty.spawn 抛错时抛 `cannot spawn shell ${shell}: ${error}` 信封
 *
 * @module corum-desktop/corum-terminal.spec
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// mock node-pty：避免测试加载原生模块（node-pty 是 NAPI 原生，且 spawn 由用例控制）
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

// mock @deepseek-ai/dsh-typert-protocol：Remote 装饰器与 TypertRemoteService 基类
// 在测试里无需真实装配，避免 cordis service 注册副作用。
vi.mock('@deepseek-ai/dsh-typert-protocol', () => ({
  TypertRemoteService: class {
    ctx: unknown
    constructor(ctx: unknown, _name: string) {
      this.ctx = ctx
    }
  },
  Remote: () => (_target: unknown, _key: string, desc: PropertyDescriptor) => desc,
}))

import * as pty from 'node-pty'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDefaultShell, CorumTerminalService } from '../src/host/corum-terminal'

describe('resolveDefaultShell — 平台 shell 分派', () => {
  describe('win32', () => {
    it('SHELL 未设置时回退 pwsh.exe + -NoLogo，不含 POSIX -l', () => {
      const r = resolveDefaultShell('win32', undefined, 'pwsh.exe')
      expect(r.shell).toBe('pwsh.exe')
      expect(r.args).toEqual(['-NoLogo'])
      expect(r.args).not.toContain('-l')
    })

    it('SHELL 未设置时回落 powershell.exe + -NoLogo', () => {
      const r = resolveDefaultShell('win32', undefined, 'powershell.exe')
      expect(r.shell).toBe('powershell.exe')
      expect(r.args).toEqual(['-NoLogo'])
      expect(r.args).not.toContain('-l')
    })

    it('SHELL 显式设置时尊重该设置（跨平台一致，args 走 -l）', () => {
      const explicit = 'C:\\Program Files\\Git\\bin\\bash.exe'
      const r = resolveDefaultShell('win32', explicit, 'pwsh.exe')
      expect(r.shell).toBe(explicit)
      expect(r.args).toEqual(['-l'])
    })

    it('SHELL 空串视为未设置，走 win32 平台分派', () => {
      const r = resolveDefaultShell('win32', '', 'pwsh.exe')
      expect(r.shell).toBe('pwsh.exe')
      expect(r.args).toEqual(['-NoLogo'])
    })

    it('SHELL 纯空白视为未设置，走 win32 平台分派', () => {
      const r = resolveDefaultShell('win32', '   ', 'powershell.exe')
      expect(r.shell).toBe('powershell.exe')
      expect(r.args).toEqual(['-NoLogo'])
    })
  })

  describe('POSIX', () => {
    it('darwin: SHELL 未设置时回退 /bin/zsh + -l（行为不变）', () => {
      const r = resolveDefaultShell('darwin', undefined, '')
      expect(r.shell).toBe('/bin/zsh')
      expect(r.args).toEqual(['-l'])
    })

    it('linux: SHELL 未设置时回退 /bin/zsh + -l（行为不变）', () => {
      const r = resolveDefaultShell('linux', undefined, '')
      expect(r.shell).toBe('/bin/zsh')
      expect(r.args).toEqual(['-l'])
    })

    it('POSIX: SHELL 显式设置时尊重该设置', () => {
      const r = resolveDefaultShell('linux', '/bin/fish', '')
      expect(r.shell).toBe('/bin/fish')
      expect(r.args).toEqual(['-l'])
    })

    it('POSIX: SHELL 空串视为未设置，回退 /bin/zsh', () => {
      const r = resolveDefaultShell('darwin', '', '')
      expect(r.shell).toBe('/bin/zsh')
      expect(r.args).toEqual(['-l'])
    })
  })
})

describe('CorumTerminalService.create — spawn 错误信封', () => {
  // create 直接读 process.platform 与 process.env.SHELL；精准 stub platform 属性
  // （vi.stubGlobal('process', ...) 会整替 process 破坏 process.env/cwd，故用
  // Object.defineProperty 只改 platform）。
  let originalPlatform: NodeJS.Platform

  beforeEach(() => {
    vi.mocked(pty.spawn).mockReset()
    originalPlatform = process.platform
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.unstubAllEnvs()
  })

  it('POSIX: pty.spawn 抛错时抛 cannot spawn shell /bin/zsh: <error> 信封', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    vi.stubEnv('SHELL', '')
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })
    const ctx = { emit: vi.fn() } as unknown as Context
    const svc = new CorumTerminalService(ctx)
    // String(Error) → "Error: <msg>"，信封即 `cannot spawn shell /bin/zsh: Error: ENOENT...`
    await expect(svc.create()).rejects.toThrow(
      /cannot spawn shell \/bin\/zsh: Error: ENOENT: no such file or directory/,
    )
  })

  it('win32: SHELL 显式设置时信封含该 shell（不走平台探测）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.stubEnv('SHELL', 'pwsh.exe')
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const ctx = { emit: vi.fn() } as unknown as Context
    const svc = new CorumTerminalService(ctx)
    await expect(svc.create()).rejects.toThrow(/cannot spawn shell pwsh\.exe: Error: spawn failed/)
  })
})