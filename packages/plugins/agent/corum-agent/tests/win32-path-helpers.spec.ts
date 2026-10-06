/**
 * win32 路径处理共享辅助 — 单元测试。
 *
 * 覆盖盘符 / UNC / 混写分隔符 / 大小写 / 尾斜杠 / 边界（空串、单字符根、纯盘符 `D:`），
 * 并断言幂等性与 POSIX 路径不误判（`/home/user` 不被判为盘符路径）。
 */
import { describe, expect, it } from 'vitest'
import {
  isRootPath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
  isWindowsRoot,
  normalizeDriveLetter,
  stripDrivePrefix,
  stripLeadingSep,
} from '../src/win32-path-helpers.ts'

describe('win32 路径辅助 — isWindowsDrivePath', () => {
  it('盘符 + 反斜杠判为盘符路径', () => {
    expect(isWindowsDrivePath('D:\\work\\foo')).toBe(true)
    expect(isWindowsDrivePath('C:\\')).toBe(true)
  })

  it('盘符 + 正斜杠判为盘符路径（混写分隔符）', () => {
    expect(isWindowsDrivePath('C:/Users/bar')).toBe(true)
    expect(isWindowsDrivePath('D:/')).toBe(true)
  })

  it('小写盘符判为盘符路径', () => {
    expect(isWindowsDrivePath('d:\\work')).toBe(true)
    expect(isWindowsDrivePath('c:/users')).toBe(true)
  })

  it('纯盘符 D: 不判为盘符路径（无分隔符）', () => {
    expect(isWindowsDrivePath('D:')).toBe(false)
    expect(isWindowsDrivePath('d:')).toBe(false)
  })

  it('POSIX 路径不误判为盘符路径', () => {
    expect(isWindowsDrivePath('/home/user')).toBe(false)
    expect(isWindowsDrivePath('/')).toBe(false)
  })

  it('UNC 路径不误判为盘符路径', () => {
    expect(isWindowsDrivePath('\\\\server\\share')).toBe(false)
    expect(isWindowsDrivePath('//server/share')).toBe(false)
  })

  it('边界：空串、单字符、非盘符开头判为 false', () => {
    expect(isWindowsDrivePath('')).toBe(false)
    expect(isWindowsDrivePath('D')).toBe(false)
    expect(isWindowsDrivePath('abc')).toBe(false)
    expect(isWindowsDrivePath(':\\foo')).toBe(false)
  })
})

describe('win32 路径辅助 — isUncPath', () => {
  it('双反斜杠开头判为 UNC', () => {
    expect(isUncPath('\\\\server\\share')).toBe(true)
    expect(isUncPath('\\\\server\\share\\dir')).toBe(true)
  })

  it('双正斜杠开头判为 UNC', () => {
    expect(isUncPath('//server/share')).toBe(true)
    expect(isUncPath('//server/share/dir')).toBe(true)
  })

  it('混写双分隔符开头判为 UNC', () => {
    expect(isUncPath('/\\server')).toBe(true)
    expect(isUncPath('\\/server')).toBe(true)
  })

  it('单分隔符不判为 UNC', () => {
    expect(isUncPath('/home/user')).toBe(false)
    expect(isUncPath('\\foo')).toBe(false)
    expect(isUncPath('/')).toBe(false)
  })

  it('盘符路径不误判为 UNC', () => {
    expect(isUncPath('D:\\work')).toBe(false)
    expect(isUncPath('C:/Users')).toBe(false)
  })

  it('边界：空串、非双分隔符开头判为 false', () => {
    expect(isUncPath('')).toBe(false)
    expect(isUncPath('server')).toBe(false)
    expect(isUncPath('a\\b')).toBe(false)
  })
})

describe('win32 路径辅助 — isWindowsAbsolutePath', () => {
  it('盘符路径判为绝对路径', () => {
    expect(isWindowsAbsolutePath('D:\\work')).toBe(true)
    expect(isWindowsAbsolutePath('C:/Users')).toBe(true)
  })

  it('UNC 路径判为绝对路径', () => {
    expect(isWindowsAbsolutePath('\\\\server\\share')).toBe(true)
    expect(isWindowsAbsolutePath('//server/share')).toBe(true)
  })

  it('POSIX 路径不误判为 win32 绝对路径', () => {
    expect(isWindowsAbsolutePath('/home/user')).toBe(false)
    expect(isWindowsAbsolutePath('/')).toBe(false)
  })

  it('相对路径与纯盘符不判为绝对路径', () => {
    expect(isWindowsAbsolutePath('foo/bar')).toBe(false)
    expect(isWindowsAbsolutePath('D:')).toBe(false)
    expect(isWindowsAbsolutePath('')).toBe(false)
  })
})

describe('win32 路径辅助 — normalizeDriveLetter', () => {
  it('小写盘符首字母大写，其余不变', () => {
    expect(normalizeDriveLetter('d:\\work\\foo')).toBe('D:\\work\\foo')
    expect(normalizeDriveLetter('c:/users/bar')).toBe('C:/users/bar')
  })

  it('已大写盘符保持不变（幂等）', () => {
    expect(normalizeDriveLetter('D:\\work')).toBe('D:\\work')
    expect(normalizeDriveLetter('C:/Users')).toBe('C:/Users')
  })

  it('纯盘符也归一', () => {
    expect(normalizeDriveLetter('d:')).toBe('D:')
    expect(normalizeDriveLetter('D:')).toBe('D:')
  })

  it('尾斜杠路径仅归一盘符，尾斜杠保留', () => {
    expect(normalizeDriveLetter('d:\\work\\')).toBe('D:\\work\\')
    expect(normalizeDriveLetter('c:/users/')).toBe('C:/users/')
  })

  it('非盘符开头原样返回（POSIX / UNC / 空串）', () => {
    expect(normalizeDriveLetter('/home/user')).toBe('/home/user')
    expect(normalizeDriveLetter('\\\\server\\share')).toBe('\\\\server\\share')
    expect(normalizeDriveLetter('')).toBe('')
    expect(normalizeDriveLetter('foo/bar')).toBe('foo/bar')
  })

  it('仅首字母大写，不改变路径其余大小写', () => {
    expect(normalizeDriveLetter('d:\\Work\\Foo')).toBe('D:\\Work\\Foo')
    expect(normalizeDriveLetter('e:/Users/Bar.txt')).toBe('E:/Users/Bar.txt')
  })

  it('幂等性：重复应用结果不变', () => {
    const cases = [
      'd:\\work\\foo',
      'D:\\work\\foo',
      'c:/users/bar',
      'C:/Users/bar',
      'd:',
      'D:',
      'd:\\work\\',
      '/home/user',
      '\\\\server\\share',
      '',
      'foo/bar',
    ]
    for (const p of cases) {
      expect(normalizeDriveLetter(normalizeDriveLetter(p))).toBe(normalizeDriveLetter(p))
    }
  })
})

describe('win32 路径辅助 — stripDrivePrefix', () => {
  it('剥盘符前缀，保留分隔符与后续内容', () => {
    expect(stripDrivePrefix('D:\\work\\foo')).toBe('\\work\\foo')
    expect(stripDrivePrefix('C:/Users/bar')).toBe('/Users/bar')
  })

  it('剥小写盘符前缀', () => {
    expect(stripDrivePrefix('d:\\work')).toBe('\\work')
    expect(stripDrivePrefix('c:/users')).toBe('/users')
  })

  it('纯盘符剥为空串', () => {
    expect(stripDrivePrefix('D:')).toBe('')
    expect(stripDrivePrefix('d:')).toBe('')
  })

  it('盘符根剥为单分隔符', () => {
    expect(stripDrivePrefix('D:\\')).toBe('\\')
    expect(stripDrivePrefix('C:/')).toBe('/')
  })

  it('尾斜杠路径剥盘符后尾斜杠保留', () => {
    expect(stripDrivePrefix('D:\\work\\')).toBe('\\work\\')
    expect(stripDrivePrefix('c:/users/')).toBe('/users/')
  })

  it('非盘符开头原样返回（POSIX / UNC / 空串）', () => {
    expect(stripDrivePrefix('/home/user')).toBe('/home/user')
    expect(stripDrivePrefix('\\\\server\\share')).toBe('\\\\server\\share')
    expect(stripDrivePrefix('')).toBe('')
    expect(stripDrivePrefix('foo/bar')).toBe('foo/bar')
  })

  it('幂等性：重复剥结果不变', () => {
    const cases = [
      'D:\\work\\foo',
      'd:\\work',
      'C:/Users/bar',
      'D:',
      'D:\\',
      'D:\\work\\',
      '/home/user',
      '\\\\server\\share',
      '',
    ]
    for (const p of cases) {
      expect(stripDrivePrefix(stripDrivePrefix(p))).toBe(stripDrivePrefix(p))
    }
  })
})

describe('win32 路径辅助 — isWindowsRoot', () => {
  it('盘符 + 单分隔符判为根', () => {
    expect(isWindowsRoot('D:\\')).toBe(true)
    expect(isWindowsRoot('C:/')).toBe(true)
    expect(isWindowsRoot('d:\\')).toBe(true)
    expect(isWindowsRoot('c:/')).toBe(true)
  })

  it('有后续内容不判为根', () => {
    expect(isWindowsRoot('D:\\work')).toBe(false)
    expect(isWindowsRoot('C:/Users')).toBe(false)
  })

  it('纯盘符不判为根（无分隔符）', () => {
    expect(isWindowsRoot('D:')).toBe(false)
    expect(isWindowsRoot('d:')).toBe(false)
  })

  it('多分隔符不判为根', () => {
    expect(isWindowsRoot('D:\\\\')).toBe(false)
    expect(isWindowsRoot('C://')).toBe(false)
  })

  it('POSIX 根与 UNC 不判为 win32 根', () => {
    expect(isWindowsRoot('/')).toBe(false)
    expect(isWindowsRoot('\\\\server\\share')).toBe(false)
  })

  it('边界：空串、单字符判为 false', () => {
    expect(isWindowsRoot('')).toBe(false)
    expect(isWindowsRoot('D')).toBe(false)
    expect(isWindowsRoot(':\\')).toBe(false)
  })
})
describe('win32 路径辅助 — isRootPath（平台分派）', () => {
  it.skipIf(process.platform !== 'win32')('win32: 盘符根 D:\\ / C:/ 判为根', () => {
    expect(isRootPath('D:\\')).toBe(true)
    expect(isRootPath('C:/')).toBe(true)
    expect(isRootPath('d:\\')).toBe(true)
    expect(isRootPath('c:/')).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('win32: POSIX / 不判为根', () => {
    expect(isRootPath('/')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('win32: 有内容的盘符路径不判为根', () => {
    expect(isRootPath('D:\\work')).toBe(false)
    expect(isRootPath('C:/Users')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('POSIX: / 判为根', () => {
    expect(isRootPath('/')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('POSIX: 盘符路径不判为根', () => {
    expect(isRootPath('D:\\')).toBe(false)
  })
})

describe('win32 路径辅助 — stripLeadingSep（平台分派）', () => {
  it.skipIf(process.platform !== 'win32')('win32: 盘符路径不剥前导（保留完整性）', () => {
    expect(stripLeadingSep('D:\\work\\foo')).toBe('D:\\work\\foo')
    expect(stripLeadingSep('C:/Users/bar')).toBe('C:/Users/bar')
  })

  it.skipIf(process.platform !== 'win32')('win32: 盘符根不剥', () => {
    expect(stripLeadingSep('D:\\')).toBe('D:\\')
    expect(stripLeadingSep('C:/')).toBe('C:/')
  })

  it.skipIf(process.platform === 'win32')('POSIX: 剥前导 /', () => {
    expect(stripLeadingSep('/foo')).toBe('foo')
    expect(stripLeadingSep('//foo')).toBe('foo')
    expect(stripLeadingSep('/')).toBe('')
  })

  it.skipIf(process.platform === 'win32')('POSIX: 无前导 / 原样返回', () => {
    expect(stripLeadingSep('foo/bar')).toBe('foo/bar')
    expect(stripLeadingSep('')).toBe('')
  })
})

describe('win32 路径辅助 — 文件面归一组合（isRootPath + stripLeadingSep）', () => {
  // 模拟 corum-fs.ts:176 / bridge.ts:273 的归一逻辑：
  //   isRootPath(p) || p === '' ? '.' : stripLeadingSep(p)
  const normalize = (p: string): string => isRootPath(p) || p === '' ? '.' : stripLeadingSep(p)

  it.skipIf(process.platform !== 'win32')('win32: 盘符根归一为 .', () => {
    expect(normalize('D:\\')).toBe('.')
    expect(normalize('C:/')).toBe('.')
  })

  it.skipIf(process.platform !== 'win32')('win32: 盘符路径归一后盘符与前导 \\ 不被错误剥离', () => {
    expect(normalize('D:\\work\\foo')).toBe('D:\\work\\foo')
    expect(normalize('C:/Users/bar')).toBe('C:/Users/bar')
  })

  it.skipIf(process.platform !== 'win32')('win32: D:\\work\\foo 判为绝对路径', () => {
    expect(isWindowsAbsolutePath('D:\\work\\foo')).toBe(true)
  })

  it('空串归一为 .（平台无关）', () => {
    expect(normalize('')).toBe('.')
  })

  it.skipIf(process.platform === 'win32')('POSIX: / 归一为 .', () => {
    expect(normalize('/')).toBe('.')
  })

  it.skipIf(process.platform === 'win32')('POSIX: 剥前导 /（与适配前一致）', () => {
    expect(normalize('/foo/bar')).toBe('foo/bar')
    expect(normalize('//foo')).toBe('foo')
  })

  it.skipIf(process.platform === 'win32')('POSIX: 无前导 / 原样（与适配前一致）', () => {
    expect(normalize('foo/bar')).toBe('foo/bar')
  })
})