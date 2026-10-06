/**
 * cold-start-trace.mjs —— renderer 冷启动性能取证（Phase 0.2）。
 *
 * 量什么：从 Page.reload 到首帧（readyState=complete + settle）之间，
 * client.js parse / Monaco init / 首屏 React mount 的耗时分布。用 CDP Tracing
 * 域抓全量 trace events，落 trace.json（可拖进 chrome://tracing 看）+
 * 一份文本摘要（按总耗时排前的 renderer 热事件）。
 *
 * 为什么这样量：CDP 端点在 renderer 页面已存在后才能连 ⇒ 错过主进程启动段。
 * 但要量的 client.js parse + Monaco init 都在 renderer 侧，reload 一次就能拿到
 * 干净的「renderer 冷启动」段。主进程启动段另用 Electron 自带计时 / 主进程 trace 量。
 *
 * 用法：
 *   ./scripts/corum-instance.sh start --home=verify   # 先起验证实例 :9333
 *   node scripts/cold-start-trace.mjs                 # 采一次 trace
 *   node scripts/cold-start-trace.mjs --settle=3000   # 首帧后多等 3s（让 Monaco mount 跑完）
 *
 * 环境变量：
 *   CDP_PORT   CDP 端口（默认 9333，验证实例）
 *   CDP_OUT    输出目录（默认 ./cold-start-trace）
 *   CORUM_REPO / CORUM_DESKTOP_PKG  主 checkout 定位（与 cdp.mjs 同口径）
 *
 * 注意：访问 127.0.0.1:9333 在 Agent 文件沙箱内会被拦（Operation not permitted），
 * 需提升权限运行。本脚本只读验证实例，绝不碰主实例 :9222（与 cdp.mjs 同守卫）。
 *
 * 状态：Phase 0.2 首版，本会话因 Windows 沙箱拦 shell 未实机跑过；首次使用请在
 * 验证实例上跑一次确认 trace.json 非空、摘要有热事件，再据此定 Phase 4 优化项。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 主 checkout 解析（与 cdp.mjs 同口径）──────────────────────────────────
function resolveRepoRoot() {
  const fromEnv = process.env.CORUM_REPO
  if (fromEnv && existsSync(join(fromEnv, 'packages/desktop/package.json'))) return fromEnv
  const own = dirname(dirname(fileURLToPath(import.meta.url)))
  if (existsSync(join(own, 'packages/desktop/package.json'))) return own
  for (const cwd of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    try {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const root = dirname(resolve(cwd, common))
      if (existsSync(join(root, 'packages/desktop/package.json'))) return root
    } catch { /* 不在 git 仓库里：继续试下一个 */ }
  }
  return undefined
}

const REPO_ROOT = resolveRepoRoot()
const DESKTOP_PKG = process.env.CORUM_DESKTOP_PKG
  ?? (REPO_ROOT ? join(REPO_ROOT, 'packages/desktop/package.json') : undefined)
if (!DESKTOP_PKG || !existsSync(DESKTOP_PKG)) {
  process.stderr.write('[cold-start] 找不到 packages/desktop/package.json；'
    + '设 CORUM_REPO=<主 checkout 根> 后重试。\n')
  process.exit(2)
}
const require = createRequire(DESKTOP_PKG)
const WebSocket = require('ws')

// 默认 = 验证实例 :9333（不是用户主实例 :9222，与 cdp.mjs 同守卫）。
const PORT = Number(process.env.CDP_PORT ?? 9333)
if (PORT === 9222 && process.env.CORUM_ALLOW_MAIN !== '1') {
  process.stderr.write('[cold-start] 拒绝操作 :9222（用户主实例）。验证一律打 :9333。\n')
  process.exit(2)
}
const OUT = process.env.CDP_OUT ?? join(process.cwd(), 'cold-start-trace')
mkdirSync(OUT, { recursive: true })

const settleArg = process.argv.find(a => a.startsWith('--settle='))
const SETTLE_MS = settleArg ? Number(settleArg.split('=')[1]) : 2000

async function getJson(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
  if (!res.ok) throw new Error(`CDP http ${res.status}`)
  return res.json()
}

async function waitPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const t = (await getJson('/json/list')).find(x => x.type === 'page'
        && (x.url.startsWith('corumapp://') || x.url.startsWith('http://127.0.0.1:'))
        && !x.url.includes('floating='))
      if (t) return t
    } catch {}
    if (Date.now() > deadline) throw new Error('no main page（应用未启动或 CDP 端口不对）')
    await new Promise(r => setTimeout(r, 500))
  }
}

// 连接 + 事件分发（cdp.mjs 只处理响应；tracing 需要收 Tracing.dataCollected 事件）。
function connect(wsUrl, onEvent) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    let seq = 0
    const pending = new Map()
    ws.on('open', () => resolveConn({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { res, rej })
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
      }),
      close: () => ws.close(),
    }))
    ws.on('message', d => {
      const m = JSON.parse(String(d))
      if (m.id !== undefined && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? rej(new Error(m.error.message)) : res(m.result)
      } else if (m.method !== undefined && onEvent) {
        onEvent(m.method, m.params, m.sessionId)
      }
    })
    ws.on('error', rejectConn)
  })
}

const page = await waitPage()
const version = await getJson('/json/version')

let markTracingComplete
const tracingDone = new Promise((r) => { markTracingComplete = r })
const traceEvents = []

const cdp = await connect(version.webSocketDebuggerUrl, (method, params) => {
  if (method === 'Tracing.dataCollected' && Array.isArray(params?.value)) {
    traceEvents.push(...params.value)
  } else if (method === 'Tracing.tracingComplete') {
    markTracingComplete()
  }
})
const att = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })
const sessionId = att.sessionId
await cdp.send('Page.enable', {}, sessionId)
await cdp.send('Runtime.enable', {}, sessionId)

// ── 采 trace：start → reload → 等 readyState=complete + settle → end ──────
// Tracing 是 browser 级域（不带 sessionId）；Page/Runtime 是 per-target（带 sessionId）。
const includedCategories = [
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.samples',
]

console.log(`[cold-start] port ${PORT} · start tracing → reload → settle ${SETTLE_MS}ms → end`)
await cdp.send('Tracing.start', { traceConfig: { includedCategories } })
await cdp.send('Page.reload', {}, sessionId)

// 等首帧：轮询 document.readyState===complete（避免改 connect 的事件订阅签名），再 settle。
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  try {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    }, sessionId)
    if (result.value === 'complete') break
  } catch { /* 页面还在 reload，稍后重试 */ }
  await new Promise(r => setTimeout(r, 300))
}
await new Promise(r => setTimeout(r, SETTLE_MS))

await cdp.send('Tracing.end')
await Promise.race([tracingDone, new Promise(r => setTimeout(r, 5000))])
cdp.close()

// ── 落 trace.json + 文本摘要 ─────────────────────────────────────────────
const traceFile = join(OUT, 'trace.json')
writeFileSync(traceFile, JSON.stringify({ traceEvents }))
console.log(`[cold-start] trace → ${traceFile}（${traceEvents.length} events）`)

// 摘要：renderer 热事件按总耗时排前 N（只看与 parse/eval/mount 相关的几类）。
const INTEREST = new Set([
  'EvaluateScript', 'ParseHTML', 'FunctionCall', 'EventDispatch',
  'TimerFire', 'XHRLoad', 'Commit', 'LayerTree',
])
const byName = new Map()
for (const e of traceEvents) {
  if (e.ph !== 'X' || !e.dur) continue
  if (!INTEREST.has(e.name)) continue
  const cur = byName.get(e.name) ?? { count: 0, total: 0 }
  cur.count++
  cur.total += e.dur
  byName.set(e.name, cur)
}
const summary = [...byName.entries()]
  .sort((a, b) => b[1].total - a[1].total)
  .map(([name, v]) => `  ${name.padEnd(16)} ×${String(v.count).padStart(4)}  ${(v.total / 1000).toFixed(1).padStart(8)}ms`)
  .join('\n')

const summaryFile = join(OUT, 'summary.txt')
writeFileSync(summaryFile,
  `cold-start trace summary\nport ${PORT} · ${traceEvents.length} events · settle ${SETTLE_MS}ms\n\n`
  + `renderer hot events (by total dur):\n${summary || '  (none matched — 检查 categories / 是否 Monaco 未触发)'}\n`)
console.log(`[cold-start] summary → ${summaryFile}`)
console.log(summary || '(none matched)')
