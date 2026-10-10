#!/usr/bin/env node
/**
 * tasklog-open.mjs —— 从 `docs/tasks/log.jsonl` **渲染**「未关闭清单」与「同 key 异值冲突」。
 *
 * 由来（台账 `docs.status-lists`，2026-09-13 用户拍板「排期」前的最低成本一半）：
 * 交接文档里那份「待办队列」是**手维护**的，于是它必然过期——2026-09-13 实测：
 * 文档 §0 写「领先 origin 6 个提交」而实况是 9；§3-B 漏了两条「待用户定」的条目。
 * 纪律是「状态清单由 tasklog 渲染」，本脚本就是那个渲染器：**清单是派生视图，
 * JSONL 才是事实**。
 *
 * 口径（与 tasklog 的设计一致）：
 * - **同 key 最后一条说了算**（append-only 日志 + 后写覆盖前写）；
 * - `decision` 是唯一能「赢」的 kind（它改状态也改值）；
 * - **同 key 不同 value = 冲突**（要么是追记时写错了 value，要么真有两套说法）——
 *   冲突单独列出，供 curation 处理；`--check` 模式下有冲突即退出码 1（可当守卫用）。
 *
 * 用法：
 *   node scripts/tasklog-open.mjs            # 渲染 markdown 到 stdout
 *   node scripts/tasklog-open.mjs --check    # 只报冲突/异常，退出码 0/1
 *   node scripts/tasklog-open.mjs --json     # 机器可读
 *   node scripts/tasklog-open.mjs --count    # **权威计数**（真解析 JSON；报行数/唯一 key/
 *                                            #   未关闭/冲突/字段覆盖/按 kind 分布）
 *
 * ⚠️ 清点规模**一律走 `--count`**，不要用 `grep -o '"key":"…"'`：那个口径只匹配紧凑
 * JSON，对 `"key": "…"`（冒号后带空格）静默漏掉，实测同一份台账得 197 vs 真值 348
 * （台账 `tooling.tasklog.count-method` 记录了两次误报的经过）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOG = join(ROOT, 'docs/tasks/log.jsonl')

/** 未关闭 = 最后一条不是 done/dropped。 */
const CLOSED = new Set(['done', 'dropped'])

/**
 * 事实类 kind：记「发生过什么 / 定了什么」，**不是可执行待办**，因此永远不会 done。
 *
 * 由台账自身的定义（`tooling.tasklog`，L12/L14）：append-only JSONL 是**事实**，
 * decision 是唯一能「赢」的条目；lesson/evidence/risk/constraint 同理是留痕。
 * 把它们计进「未关闭」会让那个数字失去意义 —— 2026-10-06 实测：渲染器报「未关闭
 * 361 条」，其中 226 条是事实、57 条是已终态（resolved/verified）被算作未关闭，
 * **真实待办只有 78 条**。故清单按 actionability 分栏，`--count` 报两个数。
 */
const FACT_KINDS = new Set([
  'decision', 'lesson', 'constraint', 'risk', 'evidence', 'rule', 'analysis',
  'survey', 'audit', 'measure', 'docs', 'finding', 'diagnosis', 'tooling',
  'upgrade', 'plan', 'design', 'methodology-fix', 'doc-fix',
])

/**
 * 「等动作」状态：**无论 kind 是什么，一律算待办**。
 *
 * 这条是「状态优先于 kind」的修正 —— 只用 kind 判会把真待办埋进事实栏：实测
 * `plan.mcp-pool-round1..6`（`in_progress`）、`upgrade.fork-11`（`awaiting-user-decision`）
 * 一类虽然 kind 是事实类，状态却明写着「正在做 / 等用户拍板」，它们是**可执行待办**。
 */
const ACTION_STATUSES = new Set([
  'doing', 'in_progress', 'planned', 'awaiting-approval', 'awaiting-user-decision',
  'ready-for-user-decision', 'partial', 'pending', 'open-recorded-not-fixed',
  'unit-verified-device-unverified', 'unmeasured', 'verified-partial',
  'improved-not-solved', 'inconclusive-for-main-list',
])

/** actionability：等动作状态优先，其次看 kind 是否为纯留痕。 */
export function actionabilityOf(row) {
  if (ACTION_STATUSES.has(row.status)) return 'work'
  return FACT_KINDS.has(row.kind ?? 'todo') ? 'fact' : 'work'
}

function loadEntries(path) {
  const rows = []
  const bad = []
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const text = line.trim()
    if (text === '') return
    try {
      rows.push(JSON.parse(text))
    } catch {
      bad.push({ line: index + 1, text: text.slice(0, 120) })
    }
  })
  return { rows, bad }
}

function build(rows) {
  const byKey = new Map()
  for (const row of rows) {
    const key = row.key ?? row.id
    if (key === undefined) continue
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }
  const open = []
  const conflicts = []
  for (const [key, list] of byKey) {
    // `supersedes`：显式裁决——后继决定声明它取代了哪个旧 value，被取代的不再算冲突
    // （与设计里的字段同义：decision 是唯一能「赢」的条目）。
    const supersededValues = new Set()
    for (const row of list) {
      const s = row.supersedes
      if (typeof s === 'string' && s !== '') supersededValues.add(s)
      else if (Array.isArray(s)) for (const v of s) if (typeof v === 'string') supersededValues.add(v)
    }
    const values = new Set(
      list.filter(row => row.kind === 'decision' && typeof row.value === 'string' && row.value !== '')
        .map(row => row.value)
        .filter(value => !supersededValues.has(value)),
    )
    if (values.size > 1) conflicts.push({ key, values: [...values] })
    const last = list[list.length - 1]
    if (!CLOSED.has(last.status)) {
      open.push({
        key,
        status: last.status ?? 'open',
        kind: last.kind ?? 'todo',
        actionability: actionabilityOf(last),
        id: last.id ?? key,
        scope: Array.isArray(last.scope) ? last.scope : [],
        created: last.created ?? '',
        author: last.author ?? '',
        summary: String(last.text ?? '').replace(/\s+/g, ' ').slice(0, 160),
      })
    }
  }
  open.sort((a, b) => (a.scope[0] ?? '').localeCompare(b.scope[0] ?? '') || a.key.localeCompare(b.key))
  return { open, conflicts }
}

function render(open, conflicts) {
  const out = []
  const work = open.filter(row => row.actionability === 'work')
  const fact = open.filter(row => row.actionability === 'fact')
  out.push(`### 未关闭 ${work.length} 条待办（另有 ${fact.length} 条事实类条目，见文末分栏）`)
  out.push('')
  out.push(`> 由 \`scripts/tasklog-open.mjs\` 从 \`docs/tasks/log.jsonl\` 渲染，**勿手改**。`)
  out.push('> 「待办」= 可执行且未收口的条目；`decision`/`lesson`/`evidence` 一类记的')
  out.push('> 是「发生过什么、定了什么」，永远不会 done，故单列 —— 混在一起报会让那个')
  out.push('> 数字失去判别力（2026-10-06 实测：混报 361 条，其中 57 条其实已是终态）。')
  out.push('')
  let scope = null
  for (const row of work) {
    const group = row.scope[0] ?? '(no scope)'
    if (group !== scope) {
      scope = group
      out.push(`**${group}**`)
    }
    const who = row.author === 'user' ? '用户' : 'Agent'
    out.push(`- \`${row.status}\` **${row.key}**（${row.created}，${who}）— ${row.summary}`)
  }
  out.push('')
  out.push(`<details><summary>事实类条目 ${fact.length} 条（decision / lesson / evidence …，非待办）</summary>`)
  out.push('')
  for (const row of fact) {
    out.push(`- \`${row.status}\` **${row.key}**（${row.created}，${row.kind}）`)
  }
  out.push('')
  out.push('</details>')
  out.push('')
  if (conflicts.length > 0) {
    out.push(`### 同 key 异值冲突 ${conflicts.length} 组（curation 待办）`)
    out.push('')
    for (const c of conflicts) out.push(`- \`${c.key}\`：${c.values.map(v => `\`${v}\``).join(' vs ')}`)
  } else {
    out.push('### 同 key 异值冲突 0 组')
  }
  return out.join('\n')
}

const { rows, bad } = loadEntries(LOG)
const { open, conflicts } = build(rows)
const mode = process.argv[2]

if (mode === '--json') {
  process.stdout.write(`${JSON.stringify({ open, conflicts, malformed: bad }, null, 2)}\n`)
} else if (mode === '--count') {
  // 权威计数口径（台账 `tooling.tasklog.count-method` 要求）：**真解析 JSON**，
  // 绝不用 `grep -o '"key":"…"'` —— 那个口径只匹配紧凑 JSON，对 `"key": "…"`
  // （冒号后带空格）静默漏掉；**按行首前几个键判形态**同样会漏（本仓 425 行走
  // `id` 在前、62 行走 `key` 在前，两种都合法且都带 key）。
  //
  // 本子命令的意义：把「报出去的那个数字」固定成可复跑、不随写法漂移的一条命令，
  // 而不是每轮临时拼 grep（这正是那条教训的由来）。
  const byKey = new Map()
  for (const row of rows) {
    const key = row.key ?? row.id
    if (key === undefined) continue
    const list = byKey.get(key) ?? []
    list.push(row)
    byKey.set(key, list)
  }
  const kinds = {}
  for (const list of byKey.values()) {
    const last = list[list.length - 1]
    const kind = last.kind ?? 'todo'
    kinds[kind] = (kinds[kind] ?? 0) + 1
  }
  console.log(`行数（真解析）      : ${rows.length}${bad.length > 0 ? `（另有坏行 ${bad.length}）` : ''}`)
  console.log(`唯一 key（key ?? id）: ${byKey.size}`)
  console.log(`未关闭（合计）      : ${open.length}`)
  console.log(`  ├ 待办（可执行）  : ${open.filter(r => r.actionability === 'work').length}`)
  console.log(`  └ 事实类（非待办）: ${open.filter(r => r.actionability === 'fact').length}`)
  console.log(`冲突                : ${conflicts.length} 组`)
  console.log(`字段覆盖            : 带 key ${rows.filter(r => r.key !== undefined).length} 行 / 带 id ${rows.filter(r => r.id !== undefined).length} 行`)
  console.log(`未关闭按 kind       : ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`)
} else if (mode === '--check') {
  if (bad.length > 0) {
    for (const b of bad) console.error(`log.jsonl:${b.line} 不是合法 JSON：${b.text}`)
  }
  for (const c of conflicts) console.error(`同 key 异值：${c.key} → ${c.values.join(' | ')}`)
  console.log(`未关闭 ${open.length} 条（待办 ${open.filter(r => r.actionability === 'work').length} / 事实类 ${open.filter(r => r.actionability === 'fact').length}）；冲突 ${conflicts.length} 组；坏行 ${bad.length} 条`)
  process.exit(bad.length > 0 || conflicts.length > 0 ? 1 : 0)
} else {
  process.stdout.write(`${render(open, conflicts)}\n`)
}
