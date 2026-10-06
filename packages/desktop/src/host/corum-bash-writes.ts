/**
 * corum-desktop/corum-bash-writes — 从一条 shell 命令串里解析「写文件形态」的目标路径。
 *
 * 台账条目 `corum/review/capture-bash-writes`（key `review.capture.tool-names`）：影子仓库
 * （corum-review.ts）原先只认**文件工具**（`write` / `edit` / `str_replace_editor`），
 * 于是走 bash 改的文件（`cmd > f`、`appended >> f`、`tee f`、`sed -i s/a/b/ f`、
 * `python - <<'EOF'` 里 `open(...,'w')`）**完全不被记录** —— 审查卡里看不见，也撤销不了。
 * 本模块负责其中「命令 → 目标路径」这一步。
 *
 * ## 设计纪律：宁可漏，不可猜错
 *
 * 路径不确定（含变量/命令替换/未加引号的通配符/`cd` 之后的相对路径）时**一律放弃**并把
 * 它计进 `unresolved`，绝不返回一个「大概是它」的路径：错误的目标会让 pre-image 抓错文件，
 * 更糟的是让「撤销」写坏/删掉一个根本不在改动里的文件（见 corum-review.ts 里 Preimage
 * 三态的那段说明）。漏掉的路径由轮末的工作区实况并集兜底（`git status --porcelain`）。
 *
 * ## 覆盖形态（有单测逐条钉住）
 *
 *   重定向： `> f` `>> f` `>| f` `N> f`（`2> f`）`&> f` `&>> f`（含引号/转义的目标）
 *   tee    ： `tee f` `tee -a f` `tee -- f g`（`-` 目标忽略，管道位置同样识别）
 *   sed -i ： `sed -i ...` `sed -i '' ...`（BSD）`sed -i.bak ...` `sed -i -e ... f g`
 *   python ： `python - <<'EOF' … open('f','w') … EOF`（heredoc 正文）、`python -c "open('f','w')"`
 *   嵌套壳 ： `bash -c 'echo x > f'`（载荷仍是命令，递归解析，最多 2 层）
 *   cd 链  ： `cd /abs && cmd > f` / `cd sub; sed -i … f`（**字面量** cd 依次解析成新基准，
 *            见 `cwdSteps`；命令里出现算不出的 cd 时相对目标一律放弃并计数）
 *
 * ## 明确不覆盖（保守放行，交给轮末并集）
 *
 *   - `cp` / `mv` / `rm` / `touch` / `dd` / `truncate` / `install` 等命令的参数；
 *   - 构建脚本、被执行的脚本文件内部（`python build.py`）自己写的文件；
 *   - `xargs sed -i …`（命令词是 xargs，参数语义不可知）；
 *   - 家目录展开 `~/x`、进程替换 `>(…)`、`{}` 展开；
 *   - 子 shell 里改的目录（`( cd x && … )` 之后 cwd 复原，解析器不跟这个栈）；
 *   - `/dev/*` `/proc/*` `/sys/*` 与 `-`：**不是文件写**，直接忽略且不计入 unresolved。
 *
 * ## 目标顺序
 *
 * 同一条命令内**不保证与源码同序**：先收全部输出重定向的目标，再收命令自己的参数目标
 * （tee / sed / python）。目标集合与顺序无关，调用方只按集合抓 pre-image。
 *
 * ## 纯函数
 *
 * 本模块**零 import、零 IO、零全局状态**：只做字符串 → 字符串的工作，因此可以被
 * 任意测试包用相对路径 import（本仓 desktop 包没有 vitest 装置，单测放在
 * `packages/plugins/agent/corum-tool-subagent/tests/review-bash-writes.spec.ts`，
 * 那是已有的 host 侧 vitest 包；落点理由：解析器是 desktop host 的实现细节，
 * 反向依赖（desktop → 插件包）会新增跨包运行时耦合，而这个方向只有测试依赖）。
 *
 * @module corum-desktop/host/corum-bash-writes
 */

/** 写入形态（仅用于日志/诊断，不参与判定）。 */
export type BashWriteKind = 'redirect' | 'tee' | 'sed' | 'python'

/** 一次扫描的结果。 */
export interface BashWriteScan {
  /** 可确定路径的写入目标（去引号后的原文；相对/绝对保持原样，由调用方解析）。 */
  targets: string[]
  /** 识别为写入形态但**路径不确定**的个数。 */
  unresolved: number
  /** 不确定的原因分档（日志诊断用）。 */
  reasons: {
    /** 含 `$VAR` / `$(…)` / 反引号。 */
    variable: number
    /** 含未加引号的通配符（可能匹配多个文件）。 */
    glob: number
    /** 同一条命令里有 `cd`，相对路径的基准目录变了。 */
    cd: number
    /** 其它（`~/x`、空路径等）。 */
    other: number
  }
  /**
   * `cd <字面量>` 链条（按出现顺序；调用方从 shell 的初始 cwd 依次 resolve）。
   * `[]` = 命令里没有 cd，相对目标按 bash 的初始 cwd 解析。
   * `null` = 出现过**无法确定**的 cd（`cd -` / `cd $DIR` / 管道里 / 子 shell 里 /
   * 多次 cd 混着 popd …）：此时相对目标已在 `reasons.cd` 里计过，不再给出。
   */
  cwdSteps: string[] | null
}

// ── 词法：命令 → 词 / 运算符 ────────────────────────────────────────────────

/** 一个词（引号已剥掉，另带「路径是否确定」的标记）。 */
interface WordToken {
  kind: 'word'
  /** 去引号后的正文；动态片段原样保留（便于日志阅读，不参与路径判定）。 */
  text: string
  /** 含运行时展开（`$VAR` / `$(…)` / 反引号）：路径不确定。 */
  dynamic: boolean
  /** 含**未加引号**的通配符：可能匹配多个文件，路径不确定。 */
  glob: boolean
  /** 出现过引号 —— `''` 这种空词必须保留（BSD sed 的 `-i ''` 靠它）。 */
  quoted: boolean
  /** 以 `~` 开头（家目录展开，本仓不解析）。 */
  tilde: boolean
  /**
   * 是重定向的**文件描述符前缀**（`2>&1` / `2>f` 里紧贴运算符的那个 `2`）：
   * 它是 fd 不是参数 —— 不当目标，`tee f 2>&1` 里的 `2` 也不能当成 tee 的目标。
   */
  fdPrefix: boolean
  /** 作为 heredoc 分隔符时，附上它的正文（供 python `open()` 扫描）。 */
  heredocBody?: string
}

/** 一个运算符。 */
interface OpToken {
  kind: 'op'
  op: string
}

type Token = WordToken | OpToken

/** 会**写**文件的输出重定向。 */
const WRITE_OPS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>'])

/** 文件描述符复制（`2>&1` / `>&2` / `<&0`）：**不是**文件写。 */
const DUP_OPS: ReadonlySet<string> = new Set(['>&', '<&'])

/** 输入重定向（含 heredoc）：不是写，别把分隔符当目标。 */
const INPUT_OPS: ReadonlySet<string> = new Set(['<', '<<', '<<-', '<<<', '<>'])

/** 全部重定向运算符（它们的操作数是文件，不是命令参数）。 */
const REDIRECT_OPS: ReadonlySet<string> = new Set([...WRITE_OPS, ...DUP_OPS, ...INPUT_OPS])

/** 命令分隔符（`&&` / `;` / 管道 / 子 shell）：切开独立命令。 */
const SEPARATOR_OPS: ReadonlySet<string> = new Set(['&&', '||', '|&', ';;', ';', '|', '&', '(', ')', '\n'])

/** 全部运算符，长优先匹配（`>>` 必须先于 `>`）。 */
const ALL_OPS: readonly string[] = ['&>>', '<<<', '<<-', '>>', '>|', '&&', '||', '|&', ';;', '&>', '>&', '<&', '<>', '<<', '>', '<', ';', '|', '&', '(', ')']

/** 前置赋值（`VAR=1 cmd`）：不是命令词。 */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** 透明包装命令：`sudo tee f` 的命令词仍是 tee。 */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set(['sudo', 'doas', 'nohup', 'exec', 'command', 'env', 'time', 'nice', 'setsid', 'stdbuf', 'caffeinate'])

/** 会改当前目录的命令：出现即表示相对路径基准不确定。 */
const CD_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'chdir'])

/** python 家族命令词。 */
const PYTHON_COMMANDS: ReadonlySet<string> = new Set(['python', 'python2', 'python3', 'py', 'pypy', 'pypy3'])

/** 取路径的最后一段（`/usr/bin/tee` → `tee`）。 */
function baseName(text: string): string {
  const cut = text.lastIndexOf('/')
  return cut < 0 ? text : text.slice(cut + 1)
}

/** 匹配位置上的运算符（长优先）；不匹配返回 null。 */
function matchOp(command: string, at: number): string | null {
  for (const op of ALL_OPS) {
    if (command.startsWith(op, at)) return op
  }
  return null
}

/**
 * 把一个展开形态原样抄进词里，并返回新的扫描位置。
 *
 * `$(…)` / `${…}` 要**按括号配对整段吃掉**：否则 `echo $(date > f)` 里的 `>` 会被
 * 误当成本命令的重定向，凭空多出一个目标。
 */
function copyExpansion(command: string, start: number, word: WordToken): number {
  const head = command[start]
  if (head === '`') {
    word.dynamic = true
    let i = start + 1
    while (i < command.length) {
      if (command[i] === '\\') { word.text += command.slice(i, i + 2); i += 2; continue }
      if (command[i] === '`') { i += 1; break }
      word.text += command[i]
      i += 1
    }
    return i
  }
  const next = command[start + 1]
  if (next === '(' || next === '{') {
    const close = next === '(' ? ')' : '}'
    let depth = 1
    let i = start + 2
    while (i < command.length && depth > 0) {
      const ch = command[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === "'" || ch === '"' || ch === '`') {
        // 引号内的括号不算配对，整段跳过（粗粒度但足够：这里只求不误判运算符）
        const end = command.indexOf(ch, i + 1)
        i = end < 0 ? command.length : end + 1
        continue
      }
      if (ch === next) depth += 1
      else if (ch === close) depth -= 1
      word.text += ch
      i += 1
    }
    word.dynamic = true
    return i
  }
  if (next === "'" || next === '"') {
    // `$'…'` / `$"…"`：ANSI-C / 本地化引号，仍是字面量，不是展开
    const end = command.indexOf(next, start + 2)
    if (end < 0) return command.length
    word.text += command.slice(start + 2, end)
    word.quoted = true
    return end + 1
  }
  // `$NAME` / `$1` / `$?` / `$$` / 裸 `$`
  const rest = command.slice(start + 1)
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0] ?? /^[0-9]+/.exec(rest)?.[0] ?? rest.slice(0, 1)
  word.text += `$${name}`
  word.dynamic = true
  return start + 1 + name.length
}

/**
 * 吃掉挂起的 heredoc 正文（返回正文之后的位置）。
 *
 * 必须吃：`cat > f <<'EOF'` 的正文里出现 `>` / `tee` 都只是**文本**，当命令解析就是误报。
 * 正文顺手附到分隔符词上，供 python `open()` 扫描复用。
 */
function consumeHeredocBodies(
  command: string,
  start: number,
  pending: { delim: string; stripTabs: boolean; token: WordToken }[],
): number {
  let i = start
  for (const heredoc of pending) {
    const lines: string[] = []
    for (;;) {
      if (i >= command.length) break
      const nl = command.indexOf('\n', i)
      const raw = nl < 0 ? command.slice(i) : command.slice(i, nl)
      const line = heredoc.stripTabs ? raw.replace(/^\t+/, '') : raw
      i = nl < 0 ? command.length : nl + 1
      if (line === heredoc.delim) break
      lines.push(raw)
      if (nl < 0) break
    }
    heredoc.token.heredocBody = lines.join('\n')
  }
  pending.length = 0
  return i
}

/** 把命令串切成词/运算符序列（含引号、转义、注释、heredoc 处理）。 */
function scanTokens(command: string): Token[] {
  const tokens: Token[] = []
  let word: WordToken | null = null
  let expectDelim: { stripTabs: boolean } | null = null
  const pendingHeredocs: { delim: string; stripTabs: boolean; token: WordToken }[] = []

  const newWord = (): WordToken => ({ kind: 'word', text: '', dynamic: false, glob: false, quoted: false, tilde: false, fdPrefix: false })
  const flush = (): void => {
    if (word === null) return
    const token = word
    word = null
    if (expectDelim !== null) {
      pendingHeredocs.push({ delim: token.text, stripTabs: expectDelim.stripTabs, token })
      expectDelim = null
    }
    tokens.push(token)
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]
    // 空白断词
    if (ch === ' ' || ch === '\t' || ch === '\r') { flush(); i += 1; continue }
    // 换行：命令行结束；先吃掉挂起的 heredoc 正文，再落一个分隔符
    if (ch === '\n') {
      flush()
      i = consumeHeredocBodies(command, i + 1, pendingHeredocs)
      tokens.push({ kind: 'op', op: '\n' })
      continue
    }
    // 注释：`#` 只在词边界起效（`a#b` 里的 # 是普通字符）
    if (ch === '#' && word === null) {
      const nl = command.indexOf('\n', i)
      i = nl < 0 ? command.length : nl
      continue
    }
    // 反斜杠：转义或续行
    if (ch === '\\') {
      const next = command[i + 1]
      if (next === '\n') { i += 2; continue }
      word ??= newWord()
      word.quoted = true
      if (next === undefined) { i += 1; continue }
      word.text += next
      i += 2
      continue
    }
    // 单引号：原文照收，无展开、无通配
    if (ch === "'") {
      word ??= newWord()
      word.quoted = true
      const end = command.indexOf("'", i + 1)
      if (end < 0) { word.text += command.slice(i + 1); i = command.length; continue }
      word.text += command.slice(i + 1, end)
      i = end + 1
      continue
    }
    // 双引号：内部 `$` / 反引号仍是展开，`*` 不是通配
    if (ch === '"') {
      word ??= newWord()
      word.quoted = true
      i += 1
      while (i < command.length) {
        const inner = command[i]
        if (inner === '"') { i += 1; break }
        if (inner === '\\') {
          const next = command[i + 1]
          if (next !== undefined && '"$`\\'.includes(next)) { word.text += next; i += 2; continue }
          word.text += inner
          i += 1
          continue
        }
        if (inner === '$' || inner === '`') { i = copyExpansion(command, i, word); continue }
        word.text += inner
        i += 1
      }
      continue
    }
    // 裸 `$` / 反引号：展开（`$'…'` 是字面量，由 copyExpansion 自己判定不置 dynamic）
    if (ch === '$' || ch === '`') {
      word ??= newWord()
      i = copyExpansion(command, i, word)
      continue
    }
    // 运算符
    const op = matchOp(command, i)
    if (op !== null) {
      // `2>f` / `2>&1`：紧贴运算符的全数字词是 fd 前缀，不是参数也不是目标。
      // （`word !== null` 就说明它与运算符之间没有空白 —— 空白会先 flush 掉。）
      if (word !== null && REDIRECT_OPS.has(op) && !word.quoted && /^[0-9]+$/.test(word.text)) {
        word.fdPrefix = true
      }
      flush()
      tokens.push({ kind: 'op', op })
      if (op === '<<' || op === '<<-') expectDelim = { stripTabs: op === '<<-' }
      i += op.length
      continue
    }
    // 普通字符
    word ??= newWord()
    if (ch === '*' || ch === '?' || ch === '[') word.glob = true
    if (ch === '~' && word.text === '' && !word.quoted) word.tilde = true
    word.text += ch
    i += 1
  }
  flush()
  return tokens
}

/** 按分隔符把 token 切成独立命令（重定向运算符留在命令内部）。 */
interface CommandGroup {
  tokens: Token[]
  /** 与**前**一个命令之间的分隔符（首个命令为 null）。 */
  sepBefore: string | null
  /** 与**后**一个命令之间的分隔符（末个命令为 null）。 */
  sepAfter: string | null
}

function groupCommands(tokens: Token[]): CommandGroup[] {
  const groups: CommandGroup[] = []
  let current: Token[] = []
  let before: string | null = null
  for (const token of tokens) {
    if (token.kind === 'op' && SEPARATOR_OPS.has(token.op)) {
      if (current.length > 0) {
        groups.push({ tokens: current, sepBefore: before, sepAfter: token.op })
        current = []
      }
      // 连续分隔符（`cmd ;; cmd`）时，最近的那个才是下一组的前置分隔符
      before = token.op
      continue
    }
    current.push(token)
  }
  if (current.length > 0) groups.push({ tokens: current, sepBefore: before, sepAfter: null })
  return groups
}

// ── 目标判定 ───────────────────────────────────────────────────────────────

/** 不是文件的写目标（设备/伪文件系统/`-`）：忽略且**不计** unresolved。 */
function isSpecialTarget(text: string): boolean {
  if (text === '/dev' || text === '/proc' || text === '/sys') return true
  if (text.startsWith('/dev/') || text.startsWith('/proc/') || text.startsWith('/sys/')) return true
  return text === '-'
}

/**
 * 绝对路径判定（POSIX `/` 开头或 win32 盘符/UNC 开头）。
 *
 * fork 门控（P2）：盘符/UNC 正则仅在 win32 上生效 —— POSIX 上 `C:/foo` 是相对路径
 * （`C:` 被当目录名，`/foo` 是其子路径），`//server/share` 亦非合法绝对路径；不加门控会让
 * `shellWriteTargets` 把 `C:/foo` 当绝对路径解析，与 POSIX 语义矛盾（写目标基准错位）。
 * POSIX 仅认 `/` 开头。
 *
 * 本模块零 import、零全局状态（见文件头注），故内联正则而非复用
 * `@corum/corum-agent` 的 `isWindowsAbsolutePath`——同源口径，注释互指。
 */
function isAbsolutePathText(text: string): boolean {
  if (text.startsWith('/')) return true
  return process.platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(text) || /^[/\\]{2}/.test(text))
}

/**
 * 一个词作为**写目标**的判定。
 * @param cwdUnknown - 命令里出现过无法确定的 `cd`（见 `BashWriteScan.cwdSteps`）。
 * @returns `ok` = 路径确定；`special` = 不是文件写；其余 = 不确定（原因分档）。
 */
function classifyTarget(word: WordToken, cwdUnknown: boolean): 'ok' | 'special' | 'variable' | 'glob' | 'cd' | 'other' {
  const text = word.text
  if (text !== '' && isSpecialTarget(text)) return 'special'
  if (word.dynamic) return 'variable'
  if (text === '') return 'other'
  if (word.glob) return 'glob'
  if (word.tilde) return 'other'
  // `cd` 之后相对路径的基准目录已经变了、又算不出它是哪个目录：宁可漏。
  // 绝对路径（POSIX '/' 或 win32 盘符/UNC）不受 cwd 影响，走 'ok'。
  if (cwdUnknown && !isAbsolutePathText(text)) return 'cd'
  return 'ok'
}

/** 命令词下标（跳过前置赋值与 `sudo`/`env` 这类透明包装）；取不到返回 -1。 */
function commandWordIndex(words: WordToken[]): number {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    if (word.dynamic) return -1
    if (ASSIGNMENT_RE.test(word.text)) continue
    if (WRAPPER_COMMANDS.has(baseName(word.text))) continue
    return i
  }
  return -1
}

// ── python `open(...)` 保守识别 ─────────────────────────────────────────────

/** 简单字符串字面量（支持 `r'…'` 前缀；f-string 视为运行时表达式）。 */
function readStringLiteral(code: string, at: number): { text: string; end: number } | null {
  let i = at
  const prefix = /^[A-Za-z]{0,2}/.exec(code.slice(i))?.[0] ?? ''
  const quoteAt = i + prefix.length
  const quote = code[quoteAt]
  if (quote !== "'" && quote !== '"') return null
  if (prefix.toLowerCase().includes('f')) return null // f-string：运行时才成型
  i = quoteAt + 1
  let text = ''
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\') { text += ch; text += code[i + 1] ?? ''; i += 2; continue }
    if (ch === quote) return { text, end: i + 1 }
    if (ch === '\n') return null // 跨行：不是简单字面量
    text += ch
    i += 1
  }
  return null
}

/** 跳过一段表达式（到顶层 `,` / `)` 之前），引号与括号配对。 */
function skipExpression(code: string, at: number): number {
  let i = at
  let depth = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === "'" || ch === '"') {
      const literal = readStringLiteral(code, i)
      if (literal !== null) { i = literal.end; continue }
      // f-string 等：整段引号内容跳过
      const end = code.indexOf(ch, i + 1)
      i = end < 0 ? code.length : end + 1
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth -= 1
      i += 1
      continue
    }
    if (ch === ',' && depth === 0) return i
    i += 1
  }
  return i
}

/** 读一个 `open(...)` 的实参表（位置参数 + `file=`/`mode=` 关键字）。 */
function readOpenCall(code: string, at: number): { path: string | null; mode: string | null } {
  const args: { name: string | null; literal: string | null }[] = []
  let i = at
  while (i < code.length) {
    while (i < code.length && /\s/.test(code[i])) i += 1
    if (i >= code.length || code[i] === ')') break
    if (code[i] === ',') { i += 1; continue }
    const keyword = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(code.slice(i))
    let name: string | null = null
    if (keyword !== null) {
      name = keyword[1]
      i += keyword[0].length
      while (i < code.length && /\s/.test(code[i])) i += 1
    }
    const literal = readStringLiteral(code, i)
    if (literal !== null) {
      args.push({ name, literal: literal.text })
      i = literal.end
      continue
    }
    i = skipExpression(code, i)
    args.push({ name, literal: null })
  }
  let positional = 0
  let path: string | null = null
  let mode: string | null = null
  for (const arg of args) {
    const slot = arg.name ?? (positional === 0 ? 'file' : positional === 1 ? 'mode' : 'other')
    if (arg.name === null) positional += 1
    if (slot === 'file' || slot === 'path' || slot === 'name') path = arg.literal
    else if (slot === 'mode') mode = arg.literal
  }
  return { path, mode }
}

/** 删掉 python 代码里的 `#` 注释（引号内的 `#` 不动），避免注释里的示例被当真。 */
function maskPythonComments(code: string): string {
  return code.split('\n').map((line) => {
    let out = ''
    let quote: string | null = null
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quote !== null) {
        out += ch
        if (ch === '\\') { out += line[i + 1] ?? ''; i += 1; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '#') break
      if (ch === "'" || ch === '"') quote = ch
      out += ch
    }
    return out
  }).join('\n')
}

/**
 * 在一段 python 代码里保守地找出「会写文件」的 `open(...)` 目标。
 *
 * 只认两种形态：第一个参数是**简单字符串字面量**，且第二个参数（或 `mode=`）是含
 * `w`/`a`/`x`/`+` 的字面量。其余（表达式路径、`f'…'`、`Path(...)`、`write_text`）一概
 * 不猜：路径不是字面量就计入 `unresolved`，模式不是字面量/只读则直接忽略。
 *
 * @param code - python 源码片段（heredoc 正文或 `-c` 参数）。
 */
export function scanPythonOpenWrites(code: string): { paths: string[]; unresolved: number } {
  const paths: string[] = []
  let unresolved = 0
  const masked = maskPythonComments(code)
  const re = /\bopen\s*\(/g
  let match = re.exec(masked)
  while (match !== null) {
    const call = readOpenCall(masked, match.index + match[0].length)
    // 模式必须是字面量且含写标志；`open(p)` / `'r'` 只读。
    if (call.mode !== null && /[wax+]/.test(call.mode)) {
      if (call.path === null || call.path === '') unresolved += 1
      else if (!paths.includes(call.path)) paths.push(call.path)
    }
    match = re.exec(masked)
  }
  return { paths, unresolved }
}

// ── 对外入口 ───────────────────────────────────────────────────────────────

/** 嵌套 shell 的命令词（`bash -c '…'` 的载荷仍是一条 shell 命令）。 */
const SHELL_COMMANDS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

/** 嵌套 shell 最多再往里解析几层（防病态嵌套把一轮拖住；实战到 2 层足够）。 */
const MAX_NESTED_SHELL_DEPTH = 2

/**
 * 解析一条 shell 命令里的写文件目标。
 *
 * @param command - bash 命令串（`tool/call` 里 `bash` 的 `command` 参数）。
 * @returns 确定的路径 + 不确定的计数（调用方据此决定抓哪些 pre-image、记什么日志）。
 */
export function parseBashWriteTargets(command: string): BashWriteScan {
  const scan: BashWriteScan = {
    targets: [],
    unresolved: 0,
    reasons: { variable: 0, glob: 0, cd: 0, other: 0 },
    cwdSteps: [],
  }
  if (command.trim() === '') return scan
  const state = newScanState([])
  scanCommandString(command, state, new Set<string>(), 0)
  return {
    targets: state.targets,
    unresolved: state.unresolved,
    reasons: state.reasons,
    cwdSteps: state.cwdSteps,
  }
}

/** 扫描的活状态（`cwdSteps` 需要被 cd 状态机原地改写）。 */
interface ScanState {
  targets: string[]
  unresolved: number
  reasons: BashWriteScan['reasons']
  cwdSteps: string[] | null
}

function newScanState(cwdSteps: string[] | null): ScanState {
  return { targets: [], unresolved: 0, reasons: { variable: 0, glob: 0, cd: 0, other: 0 }, cwdSteps }
}

/**
 * 扫一条命令串，把结果并进 `state`。
 *
 * @param depth - 嵌套 shell 层数（见 `MAX_NESTED_SHELL_DEPTH`）。
 */
function scanCommandString(command: string, state: ScanState, seen: Set<string>, depth: number): void {
  const addTarget = (word: WordToken, cwdUnknown: boolean, _kind: BashWriteKind): void => {
    const verdict = classifyTarget(word, cwdUnknown)
    if (verdict === 'special') return
    if (verdict === 'ok') {
      if (!seen.has(word.text)) { seen.add(word.text); state.targets.push(word.text) }
      return
    }
    state.unresolved += 1
    state.reasons[verdict] += 1
  }

  const tokens = scanTokens(command)
  const hasSubshell = tokens.some((token) => token.kind === 'op' && (token.op === '(' || token.op === ')'))
  for (const group of groupCommands(tokens)) {
    const cwdUnknown = state.cwdSteps === null
    // ① 一趟同时做两件事：输出重定向的目标 = 写文件；其余的词才是「命令参数」。
    // 重定向的操作数（`< input` / `>& 1` 的 `1`）与前缀 fd（`2>&1` 的 `2`）都**不是**
    // 参数 —— 否则 `tee f 2>&1` 会把 `2` 当成 tee 的目标（误报）。
    const words: WordToken[] = []
    for (let i = 0; i < group.tokens.length; i += 1) {
      const token = group.tokens[i]
      if (token.kind === 'word') {
        if (!token.fdPrefix) words.push(token)
        continue
      }
      const operand = group.tokens[i + 1]
      const hasOperand = operand !== undefined && operand.kind === 'word'
      if (WRITE_OPS.has(token.op)) {
        if (hasOperand) { addTarget(operand, cwdUnknown, 'redirect'); i += 1 }
        continue
      }
      if (DUP_OPS.has(token.op) || INPUT_OPS.has(token.op)) { if (hasOperand) i += 1 }
    }

    const cmdIndex = commandWordIndex(words)
    const commandWord = cmdIndex < 0 ? null : words[cmdIndex]
    // ② cd 状态机：`cd /abs && …` / `cd sub; …` 这类**字面量** cd 能确定新的基准目录，
    // 后面所有相对目标才有意义；只要有一处不确定（`cd -` / `cd $DIR` / 管道里 / 子 shell 里
    // / `popd`）就把 cwdSteps 置 null，之后相对目标一律按「不猜」处理。
    if (commandWord !== null && CD_COMMANDS.has(baseName(commandWord.text))) {
      const target = words[cmdIndex + 1]
      const sequential = (group.sepAfter === null || group.sepAfter === '&&' || group.sepAfter === ';' || group.sepAfter === '\n')
        && (group.sepBefore === null || group.sepBefore === '&&' || group.sepBefore === ';' || group.sepBefore === '\n')
      const plainCd = baseName(commandWord.text) === 'cd'
      const literal = target !== undefined && target.text !== '' && !target.dynamic && !target.glob && !target.tilde && target.text !== '-'
      if (state.cwdSteps === null || !sequential || !plainCd || !literal || hasSubshell || words.length > cmdIndex + 2) {
        state.cwdSteps = null
      } else {
        state.cwdSteps.push((target as WordToken).text)
      }
    }

    if (commandWord === null) continue
    const name = baseName(commandWord.text)
    const args = words.slice(cmdIndex + 1)

    // ② tee：非开关参数全是目标（`-` = stdout，忽略）
    if (name === 'tee') {
      let flagsDone = false
      for (const arg of args) {
        if (!flagsDone && arg.text === '--') { flagsDone = true; continue }
        if (!flagsDone && arg.text.startsWith('-') && arg.text !== '-') continue
        addTarget(arg, cwdUnknown, 'tee')
      }
      continue
    }

    // ③ sed -i：只有带 `-i` 才写；脚本本身不是文件
    if (name === 'sed' || name === 'gsed') {
      let inPlace = false
      let scriptSeen = false
      let flagsDone = false
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        const text = arg.text
        if (!flagsDone && text === '--') { flagsDone = true; continue }
        if (!flagsDone && (text === '-i' || text === '--in-place')) {
          inPlace = true
          // BSD sed：`-i ''` 的下一段是（可为空的）后缀，不是脚本
          const next = args[i + 1]
          if (next !== undefined && next.text === '' && next.quoted) i += 1
          continue
        }
        if (!flagsDone && (text.startsWith('-i') || text.startsWith('--in-place=')) && text.length > 2) { inPlace = true; continue }
        if (!flagsDone && (text === '-e' || text === '--expression' || text === '-f' || text === '--file')) { scriptSeen = true; i += 1; continue }
        if (!flagsDone && text.length > 2 && (text.startsWith('-e') || text.startsWith('-f'))) { scriptSeen = true; continue }
        if (!flagsDone && text.startsWith('-') && text !== '-') continue
        if (!scriptSeen) { scriptSeen = true; continue } // 第一段裸参数 = sed 脚本
        if (inPlace) addTarget(arg, cwdUnknown, 'sed')
      }
      continue
    }

    // ④ python：heredoc 正文 / `-c` 代码里的 open(...,'w')
    if (PYTHON_COMMANDS.has(name)) {
      const sources: string[] = []
      for (const token of group.tokens) {
        if (token.kind === 'word' && token.heredocBody !== undefined) sources.push(token.heredocBody)
      }
      for (let i = 0; i < args.length; i += 1) {
        const text = args[i].text
        if (text === '-c' || text === '--command') {
          const code = args[i + 1]
          if (code !== undefined) { sources.push(code.text); i += 1 }
        } else if (text.startsWith('-c') && text.length > 2) {
          sources.push(text.slice(2))
        }
      }
      for (const source of sources) {
        const found = scanPythonOpenWrites(source)
        state.unresolved += found.unresolved
        state.reasons.other += found.unresolved
        for (const path of found.paths) {
          if (seen.has(path)) continue
          seen.add(path)
          state.targets.push(path)
        }
      }
      continue
    }

    // ⑤ 嵌套 shell：`bash -c 'echo x > f'` / `sh -c "…"` 的载荷还是命令，递归一次。
    // 载荷继承当前的 cwd，但它自己的 cd **不外泄**（子 shell 改了目录不影响父 shell）。
    if (depth < MAX_NESTED_SHELL_DEPTH && SHELL_COMMANDS.has(name)) {
      for (let i = 0; i < args.length; i += 1) {
        const text = args[i].text
        let payload: string | null = null
        if (text === '-c') {
          const next = args[i + 1]
          if (next !== undefined) { payload = next.text; i += 1 }
        } else if (text.startsWith('-c') && text.length > 2) {
          payload = text.slice(2)
        }
        if (payload === null) continue
        const inner = newScanState(state.cwdSteps === null ? null : [...state.cwdSteps])
        scanCommandString(payload, inner, seen, depth + 1)
        state.targets.push(...inner.targets)
        state.unresolved += inner.unresolved
        state.reasons.variable += inner.reasons.variable
        state.reasons.glob += inner.reasons.glob
        state.reasons.cd += inner.reasons.cd
        state.reasons.other += inner.reasons.other
      }
    }
  }
}

// ── 轮末并集兜底用的 porcelain 解析 ─────────────────────────────────────────

/** `git status --porcelain -z` 的一条记录。 */
export interface PorcelainEntry {
  /** 两个状态字符（X = index 侧，Y = 工作区侧）。 */
  status: string
  /** 相对**仓库根**的路径（porcelain 恒为根相对，与 cwd 无关）。 */
  path: string
}

/**
 * 解析 `git status --porcelain -z --no-renames` 的输出。
 *
 * 为什么用 `-z`：非 `-z` 形态会给含空格/非 ASCII 的路径加引号与转义
 * （`"a\tb"`），自己反解就是重写一遍 git 的引号规则。`-z` 下路径原样输出、以 NUL 分隔。
 * 解析不出的记录直接丢（宁可漏，不要猜）。
 *
 * @param stdout - git 的原始输出（含 NUL）。
 */
export function parsePorcelainPaths(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field === '' || field === undefined) continue
    if (field.length < 4 || field[2] !== ' ') continue
    const status = field.slice(0, 2)
    entries.push({ status, path: field.slice(3) })
    // 防御：开了改名检测时 `-z` 会给重命名/拷贝跟一个额外字段（本仓传 --no-renames，用不到）
    if ((status.startsWith('R') || status.startsWith('C')) && i + 1 < fields.length) i += 1
  }
  return entries
}

// ── 轮末并集兜底：候选筛选（纯策略，IO 由调用方注入）────────────────────────

/** 筛选用到的 IO 探针（注入后本模块仍然零 import、零副作用）。 */
export interface UnionProbe {
  /** 该路径自身的 mtime（毫秒）；`null` = 路径不存在（可能被删了）。 */
  fileMtime: (abs: string) => number | null
  /** 该路径**父目录**的 mtime；取不到返回 null（文件被删时用它近似「这一轮动过这里」）。 */
  parentMtime: (abs: string) => number | null
  /** 目录的直接子项（`dir/` 折叠项的有界展开用）；不可读返回 []。 */
  children: (abs: string) => { name: string; dir: boolean }[]
}

/** `selectUnionCandidates` 的参数。 */
export interface UnionSelectOptions {
  /** 仓库根（porcelain 的路径挂在它下面）。 */
  root: string
  /**
   * 时间下限 = 本轮开始时刻 - 宽容度。mtime 早于它的路径**不算本轮改动**：
   * 否则用户自己或历史遗留的脏文件会被当成本轮改动，审查卡变成误导性的噪音。
   */
  floor: number
  /** 最多返回多少条（工作区再脏也不能把一轮拖住）。 */
  maxPaths: number
  /** `dir/` 折叠项的展开深度上限。 */
  maxDirDepth: number
  probe: UnionProbe
}

/**
 * 从 `git status --porcelain` 的记录里挑出「本轮确实动过」的候选路径（绝对路径）。
 *
 * 纯策略：mtime 与目录遍历由 `probe` 注入，因此可以脱离文件系统逐条钉死行为。
 * 只在 `corum-bash-writes` 的纯模块里做判断的好处是：这里的三条规则（跳过忽略项、
 * 「本轮动过」判据、折叠目录的有界展开）都是「宁可漏不可猜」的取舍，必须有单测。
 */
export function selectUnionCandidates(entries: PorcelainEntry[], options: UnionSelectOptions): string[] {
  const { root, floor, maxPaths, maxDirDepth, probe } = options
  // 交给 probe 的路径一律不带尾斜杠（porcelain 给目录是 `dir/`），免得探针实现要猜两种形态。
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  // win32 盘符/UNC 绝对路径已是绝对路径，直接返回不拼 base（防御：porcelain
  // 正常给相对路径，但盘符/UNC 绝对路径不应拼到 base）。正则与本模块
  // isAbsolutePathText 同源（零 import 约束，见文件头注）。
  const joinRoot = (rel: string): string => {
    if (/^[A-Za-z]:[\\/]/.test(rel) || /^[/\\]{2}/.test(rel)) return rel
    return rel.startsWith('/') ? base + rel : `${base}/${rel}`
  }
  const out: string[] = []
  /** 「本轮动过」：优先文件自己的 mtime，文件不在了退到父目录的 mtime。 */
  const touchedSince = (abs: string): boolean => {
    const own = probe.fileMtime(abs)
    if (own !== null) return own >= floor
    const parent = probe.parentMtime(abs)
    return parent !== null && parent >= floor
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDirDepth) return
    for (const child of probe.children(dir)) {
      if (out.length >= maxPaths) return
      if (child.name === '.git') continue
      const abs = `${dir}/${child.name}`
      if (child.dir) { walk(abs, depth + 1); continue }
      if (touchedSince(abs)) out.push(abs)
    }
  }

  for (const entry of entries) {
    if (out.length >= maxPaths) break
    if (entry.status === '!!') continue // 被忽略的文件：不是本轮改动
    // 未跟踪目录被 porcelain 折叠成 `dir/` 一条：目录够新时有界展开，够旧就整条丢掉。
    const isDir = entry.path.endsWith('/')
    const abs = joinRoot(isDir ? entry.path.slice(0, -1) : entry.path)
    if (isDir) {
      if (touchedSince(abs)) walk(abs, 1)
      continue
    }
    if (touchedSince(abs)) out.push(abs)
  }
  return out
}
