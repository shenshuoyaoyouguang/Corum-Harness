/**
 * MCP 行迁移的护栏（2026-09-27 用户模型：框架统一管理 / 一个服务名一个进程 / 授权共用 / 独占）。
 *
 * 改造前：`profile.mcpServers` → 每个服务一行 `@deepseek-ai/dsh-mcp-client`，**行里带完整定义**
 * （command/args/env…）⇒ 官方为每个 preset 各起一套进程、改配置要重挂、多 profile 不共享。
 * 改造后：一行 `@corum/corum-mcp-manager/proxy`，**只带 serverName**；进程与独占租约由宿主池
 * `corumMcpPool` 持有，定义在运行时从 `~/.corum/mcp-servers.json` 解析。
 *
 * 本 spec 钉住三件事（都是"改造会被悄悄回滚"的形态）：
 *   1. 授权一个服务 ⇒ 恰好一行 proxy，且 config **只有 serverName**（不许把定义写回来）；
 *   2. 停用/不存在的服务 ⇒ **不编行**（与原行为一致）；
 *   3. 全仓不再有指向 `dsh-mcp-client` 的**行**（防止有人手滑改回去）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile } from '../src/profile.ts'

let home: string
let previousHome: string | undefined

/** 造一个带 MCP 授权的 profile。 */
function profile(mcpServers: readonly string[]): AgentProfile {
  return {
    id: 'mcp-probe',
    nickname: 'MCP 探针',
    title: 'MCP 探针',
    dimension: '研发',
    baseMode: 'standard',
    prompt: 'probe',
    model: { provider: 'localhost', model: 'deepseek-v4-pro' },
    skills: [],
    mcpServers: [...mcpServers],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'system',
  }
}

beforeEach(() => {
  previousHome = process.env.CORUM_HOME
  home = mkdtempSync(join(tmpdir(), 'corum-mcp-row-'))
  writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
    servers: [
      {
        name: 'probe-mcp',
        transport: 'stdio',
        command: '/usr/local/bin/probe-mcp',
        args: ['--flag', 'value'],
        env: { TOKEN: 'secret-value' },
      },
      { name: 'disabled-mcp', transport: 'stdio', command: '/usr/local/bin/off', disabled: true },
    ],
  }))
  process.env.CORUM_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.CORUM_HOME
  else process.env.CORUM_HOME = previousHome
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('MCP 行：授权 ⇒ 恰好一行代理，且只带 serverName（2026-09-27 改造）', () => {
  it('★ 组里出现 proxy 行，config 只有 serverName', () => {
    const yml = compilePreset(profile(['probe-mcp'])).cordisYml
    expect(yml).toContain('id: mcp-probe-mcp')
    expect(yml).toContain('@corum/corum-mcp-manager/proxy')
    expect(yml).toContain('serverName: "probe-mcp"')
  })

  it('★ 定义**不再**写进行里（command/args/env 都不许出现）', () => {
    const yml = compilePreset(profile(['probe-mcp'])).cordisYml
    // 只有 proxy 行这一处在提这个服务；定义内容一律不得进 preset。
    expect(yml).not.toContain('/usr/local/bin/probe-mcp')
    expect(yml).not.toContain('--flag')
    // env 值更不能泄漏进 preset（行里带 env 是旧实现的形态）
    expect(yml).not.toContain('secret-value')
    expect(yml).not.toContain('@deepseek-ai/dsh-mcp-client')
  })

  it('★ 停用 / 不存在的服务不编行', () => {
    const yml = compilePreset(profile(['disabled-mcp', 'never-existed'])).cordisYml
    expect(yml).not.toContain('id: mcp-disabled-mcp')
    expect(yml).not.toContain('id: mcp-never-existed')
  })

  it('没有授权 ⇒ 一行 MCP 行都没有', () => {
    const yml = compilePreset(profile([])).cordisYml
    expect(yml).not.toContain('corum-mcp-manager/proxy')
  })
})
