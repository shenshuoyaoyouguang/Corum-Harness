/**
 * PluginManagerPanel —— 「插件中心浮层」（顶栏「插件」按钮打开的单例 modal）。
 *
 * 由同包 src/client/index.tsx 挂到 document.body（host.className = css.overlay →
 * createRoot(host) 渲染本组件，data-plugin-manager-overlay 是 DOM 锚点），
 * 遮罩/Escape/点外关闭都由该挂载点负责；本组件只画面板本体。
 *
 * 1:1 复刻 doc/UXDesign/design.pen 帧 ZHBVi「插件中心 · 插件市场 · 深色」
 * › IuLqM FloatingLayer › S8Fm0「插件中心面板」（960 宽、圆角 24、$glass-1）：
 * header AaHbb（标题 + 已安装数 + 关闭）→ 1px 分隔线 p6xJs → body kLHt3
 * ＝ searchRow HFfPH（搜索 + 排序）→ cats FQRAU（分类 chips）→ featured QElrj
 * （本周精选）→ marketGrid raKOG（两列卡片）。
 *
 * 已装插件管理（启停/详情/卸载）已迁往 设置 › 扩展 › 插件管理
 * （@corum/corum-ide-ui 的 SettingsExtensionsSection），本浮层不再承载。
 *
 * 唯一保留的浮层独有能力：视图管理（网格区域显隐）。设置页没有网格注入面，
 * 故降级为 body 底部的次级入口，点开切换 body 内容为区域显隐卡片网格。
 *
 * 所有色值走本包 --pm-* 变量（design.pen variables 的深/浅双值，见 module.css），
 * 组件内不出现裸 hex。
 *
 * 数据面：pluginManager.search 检索 npm registry（chips = 预设关键词，输入防抖
 * 300ms 自动检索）、pluginManager.install 安装、pluginManager.list 只用于
 * header 的已安装计数；安装成功后提示重启（restartHost bridge），不做免重启热载。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  Cable, ChevronDown, ChevronLeft, Cpu, Download, FolderOpen, KeyRound, Link2, Puzzle, Search, Server,
  ServerCog, Sparkles, Star, Terminal, X,
} from 'lucide-react'
import { getAllRegisteredSlots, getSlotMeta } from '@corum/corum-ui-base/client'
import css from './PluginManagerPanel.module.css'

/** 检索结果行（Host 侧 pluginManager.search 的 wire 形状）。 */
interface PluginSearchResult {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly installed: boolean
  /** 发布/最后更新日期（ISO 字符串，Host 取自 npm search 的 package.date）。 */
  readonly date?: string
  /** 周下载量（Host 取自 npm search object.downloads.weekly）。 */
  readonly weeklyDownloads?: number
  /** 综合评分 0-1（Host 取自 npm search object.score.final）。 */
  readonly score?: number
}

/** pluginManager.list 的返回投影：本浮层只用条目总数（header 的「已安装 N」）。 */
interface PluginListSnapshot {
  readonly entries: readonly unknown[]
}

/** 变更类操作的结果（restartRequired = 需重启 host 生效）。 */
interface MutationResult {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly log?: string
}

/** 面板对外依赖：网格隐藏集投影 + 区域显隐写入 + pluginManager RPC caller，全部注入。 */
export interface PluginManagerPanelProps {
  /** 网格 hidden 槽位集合的订阅（useSyncExternalStore 契约）。 */
  subscribeGrid: (listener: () => void) => () => void
  /** 当前 hidden 槽位快照（稳定引用，变更后换引用）。 */
  getHiddenSnapshot: () => readonly string[]
  /** 判定某注册槽位是否当前网格里的区域（过滤 cordis 内部 slot）。 */
  isRegionSlot: (slot: string) => boolean
  /** 区域显隐写入（壳内 = ctx.layout.setRegionHidden 直连网格）。 */
  onSetRegionHidden: (slot: string, hidden: boolean) => void
  /** 面板关闭（FloatingLayer closeFloating）。 */
  onClose: () => void
  /** pluginManager 命名空间的 RPC caller（0.1.2 起走官方 connection.rpc）。 */
  callRemote: <T>(method: string, args: Record<string, unknown>) => Promise<T>
}

/** 桌面 preload 桥的窄化面（红线 3：本地能力接口，不 import 壳实现包）。 */
interface DesktopBridge {
  restartHost?: () => Promise<{ ok: boolean }>
  pickDirectory?: (options?: { title?: string }) => Promise<{ path: string | null; cancelled?: boolean; error?: string }>
}

/** 取 preload 桥（非桌面壳 / 老 preload 下返回 undefined，调用方静默降级）。 */
function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { corumDesktop?: DesktopBridge }).corumDesktop
}

/** body 的两个内容态：market = 插件市场（默认），views = 视图管理（次级入口）。 */
type BodyView = 'market' | 'views'

/** 市场排序：latest = 按 date 降序，downloads = 按 weeklyDownloads 降序（客户端排序）。 */
type SortMode = 'latest' | 'downloads'

/** 排序下拉文案（design.pen：值「排序：最新」）。 */
const SORT_LABEL: Readonly<Record<SortMode, string>> = {
  latest: '排序：最新',
  downloads: '排序：下载量',
}

/**
 * 补充安装入口（沿用集成中心移除的「添加 ▾」那套文案与行为）：市场页只留
 * 搜索 + 每行安装钮，本地目录与 URL 形态的包从本面板的这两枚次按钮进。
 */
const ADD_ENTRY_LABEL = { local: '安装本地包…', url: '从 URL 安装' } as const

/** 来源条输入框的提示语（来源对应 npm spec 的形态）。 */
const ADD_ENTRY_PLACEHOLDER: Readonly<Record<'local' | 'url', string>> = {
  local: '包目录，如 file:/Users/me/dev/my-plugin',
  url: 'npm 支持的 URL，如 https://github.com/me/plugin.git 或 tarball 地址',
}

/** 分类 chip（design.pen：推荐 / Agent / 工具 / 主题 / 检索 / 终端）。 */
interface Category {
  readonly id: string
  readonly label: string
  /** chips 即预设检索关键词（已定映射）。 */
  readonly query: string
}

/** 六枚分类 chip 与它们的预设检索词。 */
const CATEGORIES: readonly Category[] = [
  { id: 'recommend', label: '推荐', query: 'corum plugin' },
  { id: 'agent', label: 'Agent', query: 'agent' },
  { id: 'tool', label: '工具', query: 'tool' },
  { id: 'theme', label: '主题', query: 'theme' },
  { id: 'search', label: '检索', query: 'search' },
  { id: 'terminal', label: '终端', query: 'terminal' },
]

/** 初始选中「推荐」并自动检索一次（挂载即检索该关键词）。 */
const INITIAL_CATEGORY = CATEGORIES[0] as Category

/** 输入防抖时长（毫秒）。 */
const SEARCH_DEBOUNCE_MS = 300

/** 检索卡片图标（npm 包无固定图标，按名称关键词映射语义图标，默认 Puzzle）。 */
function searchResultIcon(name: string, size: number): ReactNode {
  const n = name.toLowerCase()
  if (/mcp/.test(n)) return <ServerCog size={size} />
  if (/serial|uart|modbus/.test(n)) return <Cable size={size} />
  if (/ssh|sftp|key/.test(n)) return <KeyRound size={size} />
  if (/terminal|shell|bash|tty|pty/.test(n)) return <Terminal size={size} />
  if (/theme|color|dark|light|aurora/.test(n)) return <Terminal size={size} />
  if (/ai|llm|model|gpt|agent/.test(n)) return <Cpu size={size} />
  if (/search|find|grep|server|api/.test(n)) return <Server size={size} />
  return <Puzzle size={size} />
}

/** 格式化 ISO 日期为 YYYY-MM-DD；非法输入回退原串。 */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 周下载量展示（design.pen：18.2k/周）：≥1000 折算为 k，无数据显示 null。 */
function formatWeekly(n?: number): string | null {
  if (n === undefined || !Number.isFinite(n)) return null
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 评分展示（Host 给 0-1，design.pen 卡片显示 4.8 = 五分制）。 */
function formatScore(score?: number): string | null {
  if (score === undefined || !Number.isFinite(score)) return null
  return (score * 5).toFixed(1)
}

/** 插件中心浮层主体（插件市场 + 视图管理次级入口）。 */
export function PluginManagerPanel({
  subscribeGrid, getHiddenSnapshot, isRegionSlot, onSetRegionHidden, onClose, callRemote,
}: PluginManagerPanelProps) {
  const [view, setView] = useState<BodyView>('market')

  // 市场检索态：query 是输入框值，results 是最近一次检索结果。
  const [query, setQuery] = useState(INITIAL_CATEGORY.query)
  const [category, setCategory] = useState(INITIAL_CATEGORY.id)
  const [sort, setSort] = useState<SortMode>('latest')
  const [sortOpen, setSortOpen] = useState(false)
  const [results, setResults] = useState<readonly PluginSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  // header 的已安装计数（pluginManager.list；未加载完先不显示）。
  const [entries, setEntries] = useState<readonly unknown[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)

  // 补充安装入口：'local' | 'url' = 来源条展开中，null = 收起（spec 输入随条一起重置）。
  const [addSource, setAddSource] = useState<'local' | 'url' | null>(null)
  const [addSpec, setAddSpec] = useState('')

  // 排序下拉：点外部关闭（无全局状态，纯组件本地 effect）。
  const selectRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!sortOpen) return
    const onDown = (e: MouseEvent): void => {
      if (selectRef.current !== null && !selectRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [sortOpen])

  // 输入防抖的计时器（Enter / chip 点击会先取消挂起的那次）。
  const timerRef = useRef<number | null>(null)
  const cancelPending = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  useEffect(() => cancelPending, [cancelPending])

  // 网格 hidden 集投影（壳的 useSyncExternalStore 源）。
  const hidden = useSyncExternalStore(subscribeGrid, getHiddenSnapshot)
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  // 只列当前网格里的区域 leaf（过滤 cordis 内部 slot）。visibility 'fixed'/'hidden'
  // 的槽不进视图管理（fixed = 壳固定占位槽，hidden = 无独立 UI 的插件）。
  const regionSlots = useMemo(
    () => getAllRegisteredSlots()
      .filter(isRegionSlot)
      .filter((slot) => (getSlotMeta(slot)?.visibility ?? 'addable') === 'addable'),
    [isRegionSlot],
  )

  // 已安装计数：pluginManager.list 的条目总数（已装插件管理本体在设置页）。
  const refreshCount = useCallback(async () => {
    try {
      const snapshot = await callRemote<PluginListSnapshot>('list', {})
      setEntries(snapshot.entries)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [callRemote])

  useEffect(() => { void refreshCount() }, [refreshCount])

  const withBusy = useCallback(async (key: string, op: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await op()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const runSearch = useCallback(async (text: string) => {
    setSearchError(null)
    try {
      const { results: rows } = await callRemote<{ results: PluginSearchResult[] }>('search', { query: text.trim() })
      setResults(rows)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : String(error))
      setResults(null)
    }
  }, [callRemote])

  // 挂载即检索一次「推荐」关键词（chips 初始选中态）。
  useEffect(() => { void runSearch(INITIAL_CATEGORY.query) }, [runSearch])

  /** 输入变化：防抖 300ms 后检索当前文本。 */
  const onQueryChange = useCallback((text: string) => {
    setQuery(text)
    cancelPending()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void runSearch(text)
    }, SEARCH_DEBOUNCE_MS)
  }, [cancelPending, runSearch])

  /** 点分类 chip：关键词填入搜索框并立即检索。 */
  const onPickCategory = useCallback((item: Category) => {
    setCategory(item.id)
    setQuery(item.query)
    cancelPending()
    void runSearch(item.query)
  }, [cancelPending, runSearch])

  const onInstall = useCallback((name: string) => withBusy(`install:${name}`, async () => {
    const result = await callRemote<MutationResult>('install', { spec: name })
    if (!result.ok) {
      setNotice(`安装失败：${result.log ?? 'unknown error'}`)
      return
    }
    setNotice(`已安装 ${name}，重启后生效`)
    setResults(prev => prev?.map(r => (r.name === name ? { ...r, installed: true } : r)) ?? prev)
    await refreshCount()
  }), [withBusy, refreshCount, callRemote])

  // 区域显隐切换：经注入的 onSetRegionHidden 直连网格。
  const onToggleRegion = useCallback((slot: string, currentlyHidden: boolean) => {
    onSetRegionHidden(slot, !currentlyHidden)
  }, [onSetRegionHidden])

  /** 点补充入口：URL 展开来源条；本地包先弹原生目录选择器，选中后直接组装 file: spec 安装。 */
  const onPickAddEntry = useCallback((source: 'local' | 'url') => {
    if (source !== 'local') {
      setAddSpec('')
      setAddSource('url')
      return
    }
    void (async () => {
      const picked = await desktopBridge()?.pickDirectory?.({ title: '选择插件包目录' })
      const path = picked?.path ?? null
      if (path === null) return // 取消：来源条不打开
      const spec = `file:${path}`
      await withBusy(`install:${spec}`, async () => {
        const result = await callRemote<MutationResult>('install', { spec })
        if (!result.ok) {
          setNotice(`安装失败：${result.log ?? '未知错误'}`)
          return
        }
        setNotice(`已安装 ${spec}，重启后生效`)
        await refreshCount()
      })
    })()
  }, [withBusy, callRemote, refreshCount])

  /** 提交来源条的 spec（host install 就是 pnpm add <spec>，file:/git/tarball 天然支持）。 */
  const onSubmitAdd = useCallback(() => {
    const spec = addSpec.trim()
    if (spec === '') return
    void withBusy(`install:${spec}`, async () => {
      const result = await callRemote<MutationResult>('install', { spec })
      if (!result.ok) {
        setNotice(`安装失败：${result.log ?? '未知错误'}`)
        return
      }
      setNotice(`已安装 ${spec}，重启后生效`)
      setAddSpec('')
      setAddSource(null)
      await refreshCount()
    })
  }, [addSpec, withBusy, callRemote, refreshCount])

  const onRestart = useCallback(() => {
    void desktopBridge()?.restartHost?.()?.then(() => { setNotice(null) })
  }, [])

  // 客户端排序当前结果：latest = date 降序，downloads = weeklyDownloads 降序。
  const sorted = useMemo(() => {
    const rows = [...(results ?? [])]
    if (sort === 'downloads') {
      rows.sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
    } else {
      rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    }
    return rows
  }, [results, sort])

  // 推荐位 = 当前结果第一条（推荐词的首条即「本周精选」）；网格里照常显示，不去重。
  const featured = sorted.length > 0 ? sorted[0] as PluginSearchResult : null

  return (
    <div className={css.panel} role="dialog" aria-modal="true" aria-label="插件中心">
      {/* ── header AaHbb：标题 + 已安装计数 + 关闭 ── */}
      <div className={css.header}>
        <span className={css.headerTitle}>插件中心</span>
        <div className={css.headerRight}>
          {entries !== null && <span className={css.installedCount}>已安装 {entries.length}</span>}
          <CloseButton onClose={onClose} />
        </div>
      </div>
      <div className={css.divider} />

      {/* ── body kLHt3：插件市场四段（搜索行 / chips / 推荐位 / 卡片网格）
          ＋ 底部「视图管理」次级入口 ── */}
      <div className={css.body}>
        {view === 'views' ? (
          <>
            <button type="button" className={css.backRow} onClick={() => { setView('market') }}>
              <ChevronLeft size={14} /> 返回插件市场
            </button>
            <div className={css.hintText}>控制各区域在窗口中的显示/隐藏，隐藏后插件仍在后台运行。</div>
            {regionSlots.length === 0 && <div className={css.hintText}>没有可管理的区域</div>}
            <div className={css.grid}>
              {regionSlots.map((slot) => {
                const isHidden = hiddenSet.has(slot)
                const label = getSlotMeta(slot)?.label ?? slot
                return (
                  <div key={slot} className={css.card}>
                    <div className={css.cardMeta}>
                      <div className={css.cardNameRow}>
                        <span className={css.cardName}>{label}</span>
                        <span className={css.cardVer}>{slot}</span>
                      </div>
                    </div>
                    <div className={css.cardOps}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!isHidden}
                        aria-label={`${label} 显示开关`}
                        className={css.switch}
                        data-off={isHidden || undefined}
                        onClick={() => { onToggleRegion(slot, isHidden) }}
                      >
                        <span className={css.switchKnob} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <>
            {/* searchRow HFfPH：searchBox d4WRKA（flex 1）+ sort yFEtD */}
            <div className={css.searchRow}>
              <div className={css.searchBox}>
                <Search size={14} className={css.searchIcon} />
                <input
                  className={css.searchInput}
                  value={query}
                  placeholder="搜索插件，如 git、theme、terminal…"
                  aria-label="搜索插件"
                  onChange={e => { onQueryChange(e.target.value) }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    cancelPending()
                    void runSearch(query)
                  }}
                />
              </div>
              <div className={css.sort} ref={selectRef}>
                <button
                  type="button"
                  className={css.sortBtn}
                  aria-haspopup="listbox"
                  aria-expanded={sortOpen}
                  onClick={() => { setSortOpen(open => !open) }}
                >
                  <span className={css.sortValue}>{SORT_LABEL[sort]}</span>
                  <ChevronDown size={14} className={css.sortChevron} />
                </button>
                {sortOpen && (
                  <div className={css.sortMenu} role="listbox" aria-label="排序方式">
                    {(Object.keys(SORT_LABEL) as SortMode[]).map(id => (
                      <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={sort === id}
                        className={css.sortOption}
                        data-active={sort === id || undefined}
                        onClick={() => { setSort(id); setSortOpen(false) }}
                      >{SORT_LABEL[id]}</button>
                    ))}
                  </div>
                )}
              </div>
              {/* 补充安装入口：本地目录（原生选择器）/ URL（页内来源条），玻璃底次按钮 */}
              {(['local', 'url'] as const).map(source => (
                <button
                  key={source}
                  type="button"
                  className={css.addEntryBtn}
                  onClick={() => { onPickAddEntry(source) }}
                >
                  {source === 'local' ? <FolderOpen size={14} className={css.addEntryIcon} /> : <Link2 size={14} className={css.addEntryIcon} />}
                  {ADD_ENTRY_LABEL[source]}
                </button>
              ))}
            </div>

            {/* 来源条：URL 入口展开（本地包走目录选择器不经此条），Enter 直装 */}
            {addSource !== null && (
              <div className={css.sourceBar}>
                <span className={css.sourceLabel}>{ADD_ENTRY_LABEL[addSource]}</span>
                <input
                  className={css.sourceInput}
                  value={addSpec}
                  placeholder={ADD_ENTRY_PLACEHOLDER[addSource]}
                  aria-label={ADD_ENTRY_LABEL[addSource]}
                  onChange={e => { setAddSpec(e.target.value) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSubmitAdd() }}
                />
                <button
                  type="button"
                  className={css.sourceBtn}
                  disabled={addSpec.trim() === '' || busy.has(`install:${addSpec.trim()}`)}
                  onClick={onSubmitAdd}
                >安装</button>
                <button
                  type="button"
                  className={css.sourceCancel}
                  aria-label="取消安装"
                  onClick={() => { setAddSource(null); setAddSpec('') }}
                ><X size={14} /></button>
              </div>
            )}

            {/* cats FQRAU：六枚分类 chip = 预设检索关键词 */}
            <div className={css.chips} role="group" aria-label="插件分类">
              {CATEGORIES.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={css.chip}
                  data-active={category === item.id || undefined}
                  aria-pressed={category === item.id}
                  onClick={() => { onPickCategory(item) }}
                >{item.label}</button>
              ))}
            </div>

            {loadError !== null && <div className={css.errorText}>加载失败：{loadError}</div>}

            {/* featured QElrj：本周精选 = 结果第一条 */}
            {featured !== null && (
              <div className={css.featured}>
                <div className={css.featuredIcon}><Sparkles size={22} /></div>
                <div className={css.featuredCol}>
                  <div className={css.featuredTagRow}>
                    <Star size={12} className={css.featuredStar} />
                    <span className={css.featuredTag}>本周精选</span>
                  </div>
                  <span className={css.featuredName}>{featured.name}</span>
                  {featured.description !== undefined && featured.description !== '' && (
                    <span className={css.featuredDesc}>{featured.description}</span>
                  )}
                  <div className={css.featuredMeta}>
                    <span className={css.monoVer}>v{featured.version}</span>
                    {formatWeekly(featured.weeklyDownloads) !== null && (
                      <>
                        <span className={css.metaSep}>·</span>
                        <span className={css.metaDim}>{formatWeekly(featured.weeklyDownloads)}/周</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className={css.installBtnLg}
                  data-installed={featured.installed || undefined}
                  disabled={featured.installed || busy.has(`install:${featured.name}`)}
                  onClick={() => { void onInstall(featured.name) }}
                >{featured.installed ? '已安装' : '安装'}</button>
              </div>
            )}

            {searchError !== null && <div className={css.errorText}>检索失败：{searchError}</div>}
            {results !== null && sorted.length === 0 && <div className={css.hintText}>没有匹配的包</div>}

            {/* marketGrid raKOG：两列卡片 */}
            <div className={css.marketGrid}>
              {sorted.map(row => (
                <MarketCard
                  key={row.name}
                  row={row}
                  busy={busy.has(`install:${row.name}`)}
                  onInstall={onInstall}
                />
              ))}
            </div>

            {/* 视图管理次级入口：网格区域显隐是浮层独有能力（设置页无网格注入面） */}
            <div className={css.viewsRow}>
              <button type="button" className={css.viewsEntry} onClick={() => { setView('views') }}>视图管理</button>
            </div>
          </>
        )}
      </div>

      {/* 操作反馈条：body 之外的 footer（仅在有提示时渲染） */}
      {notice !== null && (
        <div className={css.notice}>
          <span className={css.noticeText}>{notice}</span>
          {notice.includes('重启') && (
            <button type="button" className={css.noticeAction} onClick={onRestart}>立即重启</button>
          )}
          <button type="button" className={css.noticeClose} aria-label="关闭提示" onClick={() => { setNotice(null) }}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

/** header 右侧关闭按钮（18×18，lucide x 20px）。 */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className={css.closeBtn} aria-label="关闭" onClick={onClose}>
      <X size={20} />
    </button>
  )
}

/** 市场卡片（design.pen uxN7L：head + desc + stats + meta，一排两张）。 */
function MarketCard({ row, busy, onInstall }: {
  row: PluginSearchResult
  busy: boolean
  onInstall: (name: string) => void
}) {
  const weekly = formatWeekly(row.weeklyDownloads)
  const score = formatScore(row.score)
  const date = row.date !== undefined && row.date !== '' ? formatDate(row.date) : null
  return (
    <div className={css.mktCard}>
      <div className={css.mktCardHead}>
        <div className={css.mktCardLeft}>
          <div className={css.mktIconBox}>{searchResultIcon(row.name, 17)}</div>
          <span className={css.mktName}>{row.name}</span>
        </div>
        <button
          type="button"
          className={css.installBtn}
          data-installed={row.installed || undefined}
          disabled={row.installed || busy}
          onClick={() => { onInstall(row.name) }}
        >{row.installed ? '已安装' : '安装'}</button>
      </div>
      {row.description !== undefined && row.description !== '' && (
        <span className={css.mktDesc}>{row.description}</span>
      )}
      {(score !== null || weekly !== null) && (
        <div className={css.mktStats}>
          {score !== null && (
            <>
              <Star size={11} className={css.statStar} />
              <span className={css.mktScore}>{score}</span>
            </>
          )}
          {weekly !== null && (
            <>
              <Download size={11} className={css.statDlIcon} />
              <span className={css.mktDl}>{weekly}/周</span>
            </>
          )}
        </div>
      )}
      <div className={css.mktMeta}>
        <span className={css.monoVer}>v{row.version}</span>
        {date !== null && (
          <>
            <span className={css.metaSep}>·</span>
            <span className={css.metaDim}>{date}</span>
          </>
        )}
      </div>
    </div>
  )
}
