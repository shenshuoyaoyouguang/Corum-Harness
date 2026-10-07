/**
 * 根包含不变式（见 CONTEXT.md）：逃逸必须被拒绝。
 *
 * 两个缝：
 *   A · CorumFsService 的公开方法（9 个 @Remote 端点）——本轮 bug 的成因是
 *       「端点没调守卫」，只有端点级测试能挡住第 12 个漏配的端点。
 *   B · resolveInsideRoot 的接口——策略矩阵里从端点够不着的部分
 *       （denyRoot / win32 盘根 / 最近存在祖先 / reason 判别）。
 *
 * A1 的 3 例是修复前的红灯（`promise resolved … instead of rejecting`）：
 * mkdir 无 realpath 校验、write 新文件跳过校验、rename 目标侧仅词法校验。
 *
 * @module corum-desktop/corum-fs-root-containment.spec
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// mock @deepseek-ai/dsh-typert-protocol：Remote 装饰器与基类在测试里无需真实装配
// （避免 cordis service 注册副作用；与 corum-terminal.spec.ts 同款）。
vi.mock('@deepseek-ai/dsh-typert-protocol', () => ({
  TypertRemoteService: class {
    ctx: unknown
    constructor(ctx: unknown, _name: string) {
      this.ctx = ctx
    }
  },
  Remote: () => (_target: unknown, _key: string, desc: PropertyDescriptor) => desc,
}))

// mock node:child_process：reveal 会真起文件管理器——断言它「被拒绝时不启动外部程序」，
// 同时避免红灯状态下在开发机上弹窗。
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { CorumFsService } from '../src/host/corum-fs'
import { ProjectRootDeniedError, resolveInsideRoot } from '../src/host/project-root'

/** 现场：baseDir/root/ 内有 link → baseDir/outside/。 */
interface Scene {
  baseDir: string
  root: string
  outside: string
}

/**
 * 建目录链接。win32 用 junction——目录 symlink 需要开发者模式 / admin，
 * junction 不需要（本仓打包链路同款绕行）。
 */
async function linkDir(target: string, at: string): Promise<void> {
  if (process.platform === 'win32') await symlink(target, at, 'junction')
  else await symlink(target, at)
}

async function makeEscapeScene(): Promise<Scene> {
  const baseDir = await realpath(await mkdtemp(join(tmpdir(), 'corum-root-')))
  const root = join(baseDir, 'root')
  const outside = join(baseDir, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await linkDir(outside, join(root, 'link'))
  return { baseDir, root, outside }
}

let scene: Scene
let svc: CorumFsService

beforeEach(async () => {
  scene = await makeEscapeScene()
  svc = new CorumFsService({} as Context)
  await svc.setRoot(scene.root)
})

afterEach(async () => {
  await rm(scene.baseDir, { recursive: true, force: true })
})

describe('A1 · 逃逸复现（修复前红）', () => {
  it('mkdir：经根内链接建目录必须拒绝，且根外不得建出目录', async () => {
    await expect(svc.mkdirp('link/escaped')).rejects.toThrow()
    expect(existsSync(join(scene.outside, 'escaped'))).toBe(false)
  })

  it('write：经根内链接写新文件必须拒绝，且根外不得建出文件', async () => {
    await expect(svc.write('link/escaped.txt', 'pwned')).rejects.toThrow()
    expect(existsSync(join(scene.outside, 'escaped.txt'))).toBe(false)
  })

  it('renamePath：目标经根内链接必须拒绝，且根外不得出现被移动的文件', async () => {
    writeFileSync(join(scene.root, 'inside.txt'), 'payload')
    await expect(svc.renamePath('inside.txt', 'link/moved.txt')).rejects.toThrow()
    expect(existsSync(join(scene.outside, 'moved.txt'))).toBe(false)
    expect(existsSync(join(scene.root, 'inside.txt'))).toBe(true)
  })
})

describe('A2 · 9 个端点各自拒绝一个逃逸输入（防漏网点）', () => {
  beforeEach(() => {
    // 逃逸目标必须真实存在——否则「拒绝」可能只是因为目标不存在（同义反复）。
    mkdirSync(join(scene.baseDir, 'outside-probe'))
    writeFileSync(join(scene.baseDir, 'outside-probe.txt'), 'intact')
    writeFileSync(join(scene.baseDir, 'outside-probe.png'), 'intact')
  })

  const cases: { endpoint: string; run: (target: CorumFsService) => Promise<unknown> }[] = [
    { endpoint: 'list', run: s => s.list('../outside-probe') },
    { endpoint: 'read', run: s => s.read('../outside-probe.txt') },
    { endpoint: 'readBinary', run: s => s.readBinary('../outside-probe.png') },
    { endpoint: 'absolutePath', run: s => s.absolutePath('../outside-probe') },
    { endpoint: 'reveal', run: s => s.reveal('../outside-probe') },
    { endpoint: 'write', run: s => s.write('../outside-probe.txt', 'overwritten') },
    { endpoint: 'mkdir', run: s => s.mkdirp('../outside-probe') },
    { endpoint: 'delete', run: s => s.remove('../outside-probe') },
    { endpoint: 'rename', run: s => s.renamePath('../outside-probe', 'stolen') },
  ]

  it.each(cases)('$endpoint：拒绝逃逸，且根外目标不被改动', async ({ run }) => {
    await expect(run(svc)).rejects.toThrow()
    expect(existsSync(join(scene.baseDir, 'outside-probe'))).toBe(true)
    expect(existsSync(join(scene.baseDir, 'outside-probe.png'))).toBe(true)
    expect(readFileSync(join(scene.baseDir, 'outside-probe.txt'), 'utf8')).toBe('intact')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('A3 · 根内合法路径照常工作（防过度拒绝）', () => {
  it('mkdir：多层新目录照常创建', async () => {
    await svc.mkdirp('sub/nested/deep')
    expect(existsSync(join(scene.root, 'sub/nested/deep'))).toBe(true)
  })

  it('write：新文件照常写入并可读回', async () => {
    await svc.write('sub/new.txt', 'hello')
    await expect(readFile(join(scene.root, 'sub/new.txt'), 'utf8')).resolves.toBe('hello')
  })

  it('list / read / rename / delete：根内往返照常工作', async () => {
    await svc.write('sub/new.txt', 'hello')
    const listed = await svc.list('/')
    expect(listed.entries.some(entry => entry.name === 'sub')).toBe(true)
    await expect(svc.read('sub/new.txt')).resolves.toMatchObject({ content: 'hello' })
    await svc.renamePath('sub/new.txt', 'sub/renamed.txt')
    expect(existsSync(join(scene.root, 'sub/renamed.txt'))).toBe(true)
    await svc.remove('sub/renamed.txt')
    expect(existsSync(join(scene.root, 'sub/renamed.txt'))).toBe(false)
  })
})

describe('B · resolveInsideRoot 的策略矩阵', () => {
  it('denyRoot：根本身被拒（remove / rename 源侧的策略）', async () => {
    await expect(resolveInsideRoot(scene.root, '/', { denyRoot: true }))
      .rejects.toBeInstanceOf(ProjectRootDeniedError)
    await expect(resolveInsideRoot(scene.root, '', { denyRoot: true }))
      .rejects.toBeInstanceOf(ProjectRootDeniedError)
  })

  it('denyRoot 默认关闭：根本身照常解析（list / write 允许根）', async () => {
    await expect(resolveInsideRoot(scene.root, '/')).resolves.toMatchObject({ target: scene.root })
  })

  it('词法逃逸 → reason: lexical（含越出根的 .. 与绝对路径）', async () => {
    await expect(resolveInsideRoot(scene.root, '../outside-probe'))
      .rejects.toMatchObject({ reason: 'lexical' })
  })

  it('链接逃逸 → reason: symlink', async () => {
    writeFileSync(join(scene.outside, 'probe.txt'), 'intact')
    await expect(resolveInsideRoot(scene.root, 'link/probe.txt'))
      .rejects.toMatchObject({ reason: 'symlink' })
  })

  it('不存在的深层目标经链接出根 → reason: ancestor', async () => {
    await expect(resolveInsideRoot(scene.root, 'link/a/b/c'))
      .rejects.toMatchObject({ reason: 'ancestor' })
  })

  it('不存在的深层目标在根内 → 放行，real 为 null', async () => {
    const resolved = await resolveInsideRoot(scene.root, 'new/a/b/c')
    expect(resolved.real).toBeNull()
    expect(resolved.target).toBe(join(scene.root, 'new', 'a', 'b', 'c'))
  })

  it('win32 盘根输入等同项目根（与 list / 媒体路由既有语义对齐）', async () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await expect(resolveInsideRoot(scene.root, 'D:\\')).resolves.toMatchObject({ target: scene.root })
    } finally {
      spy.mockRestore()
    }
  })
})
