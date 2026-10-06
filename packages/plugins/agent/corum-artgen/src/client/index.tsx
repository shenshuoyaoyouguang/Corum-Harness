/**
 * @corum/corum-artgen client half — 在「扩展」设置分组注册「本地文生图」页。
 *
 * 插件启用后，设置中心「扩展」分组自动出现「本地文生图（Art Generator）」页：
 * 引擎状态（sd-cli 是否已下载 + 已下载模型数）+ 引擎/模型下载 + 生成测试区。
 * 数据走 host corumArtGen RPC（connection.rpc.call → /api/corumArtGen/*）。
 *
 * @module @corum/corum-artgen/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// P2-7：下载进度事件载荷 + cordis Events/$on 合并面。
import type { ArtgenDownloadProgressEvent, ArtgenJobProgressEvent } from '@corum/corum-api-remotes/corum-events'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** sd-cli 可用模型文件（.safetensors / .gguf）。 */
interface SdModel {
  fileName: string
  displayName: string
  size: string
  sizeBytes: number
  active?: boolean
  architecture?: string
  quantization?: string
  vramGb?: number
  recommendedSteps?: number
  recommendedSize?: number
}

/** 推荐模型（低/中/高配档位）。 */
interface RecommendedSdModel {
  tier: 'low' | 'mid' | 'high'
  name: string
  fileName: string
  architecture: string
  quantization: string
  size: string
  vramGb: number
  recommendedSteps: number
  recommendedSize: number
  description: string
  compatible?: boolean
  incompatibleReason?: string
}

/** 线上模型目录条目。 */
interface OnlineSdModel {
  repoId: string
  name: string
  fileName: string
  architecture: string
  downloads: number
  likes: number
  downloadUrl: string
}

interface GpuInfo {
  name: string
  vramGb: number
  vendor: 'nvidia' | 'amd' | 'apple-metal' | 'intel'
}

/** 本地文生图引擎状态。 */
interface ArtGenStatus {
  /** sd-cli 是否已下载到本地。 */
  engineBundled: boolean
  /** sd-cli 可执行文件路径（引擎未下载时为空串）。 */
  enginePath: string
  /** 已下载的模型列表。 */
  models: SdModel[]
  /** 断点残片（fileName → 已下载字节；>0 = 可继续下载）。 */
  partials: Array<{ fileName: string; bytes: number }>
  /** Flux 文本编码器是否就位（缺了 sd-cli 处理不了提示词 → 生成必失败）。 */
  textEncoders: { clipL: boolean; t5xxl: boolean }
  /** 运行平台（process.platform）。 */
  platform: string
  /** 物理内存（GB）。 */
  totalMemGb: number
  /** 是否达到最低硬件门槛。 */
  meetsMinReq: boolean
  /** 不达标原因。 */
  minReqReason?: string
  /** GPU 信息。 */
  gpu: GpuInfo | null
  /** CPU 核心数。 */
  cpuCores: number
}

/** txt2img 推理参数。 */
interface Txt2ImgArgs {
  prompt: string
  negativePrompt?: string
  model?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  sampler?: string
  seed?: number
}

/** txt2img 推理结果。 */
interface Txt2ImgResult {
  imageBase64: string
  seed: number
  durationMs: number
}

/** txt2img 任务（startTxt2Img 启动，getTxt2ImgJob 轮询真实进度）。 */
interface Txt2ImgJob {
  id: string
  status: 'running' | 'done' | 'error'
  percent: number
  phase: string
  result?: Txt2ImgResult
  error?: string
}

function makeCall(connection: ConnectionHandle) {
  return async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `corumArtGen/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }

function Row({ label, desc, children }: { label: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 2px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        {desc !== undefined && <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function platformName(p: string): string {
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
}

/** 字节数 → 人类可读大小（renderer 端）。 */
function formatBytesClient(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[i]}`
}

/** 下载进度视图（引擎 / 模型共用；含速度/ETA）。 */
interface DownloadProgressView {
  percent: number
  total: string
  downloaded: string
  status: string
  speed?: string
  eta?: string
}

/** 剩余时间标签（秒 → 中文短语）。 */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`
}

/** 通用下载进度条（引擎 / 模型共用）。 */
function DownloadProgressBar({ progress }: { progress: DownloadProgressView | null }): ReactNode {
  if (progress === null) return null
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
          <div style={{
            width: `${progress.percent}%`, height: '100%', borderRadius: 3,
            background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
          }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{progress.percent}%</span>
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flexWrap: 'wrap' }}>
        <span>已下载：{progress.downloaded} / {progress.total}</span>
        {progress.speed !== undefined && <span style={{ color: 'var(--dsw-alias-brand-primary)' }}>速度：{progress.speed}</span>}
        {progress.eta !== undefined && <span>剩余约 {progress.eta}</span>}
        <span>状态：{progress.status === 'downloading' ? '下载中' : progress.status === 'done' ? '完成' : progress.status === 'error' ? '失败' : progress.status}</span>
      </div>
    </div>
  )
}

const SIZES: number[] = [256, 512, 1024]
const DEFAULT_PROMPT = 'minimalist flat vector avatar icon for an AI assistant, soft gradient glass style, centered, clean background'

function ArtGenSection({ call, subscribeProgress, subscribeJobProgress }: {
  call: ReturnType<typeof makeCall>
  /** P2-7：下载进度推送订阅（apply 侧绑定 ctx.remote.$on）。 */
  subscribeProgress: (listener: (p: ArtgenDownloadProgressEvent) => void) => () => void
  /** P2-7：文生图任务进度推送订阅。 */
  subscribeJobProgress: (listener: (p: ArtgenJobProgressEvent) => void) => () => void
}): ReactNode {
  const [status, setStatus] = useState<ArtGenStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, setBusy] = useState(false)

  // 引擎下载
  const [dlEngine, setDlEngine] = useState(false)
  const [dlEngineProgress, setDlEngineProgress] = useState<DownloadProgressView | null>(null)

  // 模型下载（dlModelKey 标识当前下载项：推荐档位 'low|mid|high' 或在线模型 fileName；
  // 只让正在下载的那一项显示「下载中」，其余项不受波及——修「下载 A 时删 B，B 也显下载中」）
  const [dlModelKey, setDlModelKey] = useState<string | null>(null)
  const [dlModelProgress, setDlModelProgress] = useState<DownloadProgressView | null>(null)

  // 生成测试区
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [size, setSize] = useState(512)
  const [steps, setSteps] = useState(20)
  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState(0)
  const [resultImage, setResultImage] = useState<string | null>(null)
  const [genDuration, setGenDuration] = useState<number | null>(null)

  // 常驻模式（sd-server，模型常驻内存）
  const [resident, setResident] = useState<{ enabled: boolean; running: boolean; model?: string; serverBundled: boolean } | null>(null)
  const [residentBusy, setResidentBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      const [s, r] = await Promise.all([
        call<ArtGenStatus>('status', {}),
        call<{ enabled: boolean; running: boolean; model?: string; serverBundled: boolean }>('getResidentStatus', {}),
      ])
      setStatus(s)
      setResident(r)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleResident = async (enabled: boolean): Promise<void> => {
    setResidentBusy(true)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('setResidentMode', { enabled })
      if (!r.ok) setError(r.error ?? '切换常驻模式失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setResidentBusy(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  /** 事件/轮询载荷 → 进度视图（含速度/ETA）。 */
  const toView = (p: { percent: number; totalBytes: number; downloadedBytes: number; status: string; bytesPerSecond?: number; etaSeconds?: number }): DownloadProgressView => ({
    percent: p.percent,
    total: formatBytesClient(p.totalBytes),
    downloaded: formatBytesClient(p.downloadedBytes),
    status: p.status,
    ...(p.bytesPerSecond !== undefined && p.bytesPerSecond > 0 ? { speed: `${formatBytesClient(p.bytesPerSecond)}/s` } : {}),
    ...(p.etaSeconds !== undefined && p.etaSeconds > 0 ? { eta: formatEta(p.etaSeconds) } : {}),
  })

  // 引擎下载（2026-09-09：改非阻塞 startDownloadEngine + 事件/轮询；可断点续传）。
  const downloadEngine = async (): Promise<void> => {
    setDlEngine(true)
    setError(null)
    setDlEngineProgress({ percent: 0, total: '0 B', downloaded: '0 B', status: 'downloading' })
    try {
      const r = await call<{ started: boolean; already?: boolean; error?: string }>('startDownloadEngine', {})
      if (r.error !== undefined) { setError(r.error); setDlEngine(false) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDlEngine(false)
    }
  }

  const downloadModel = async (tier: 'low' | 'mid' | 'high'): Promise<void> => {
    setDlModelKey(tier)
    setError(null)
    setDlModelProgress({ percent: 0, total: '0 B', downloaded: '0 B', status: 'downloading' })
    try {
      const r = await call<{ started: boolean; already?: boolean; error?: string }>('startDownloadModel', { tier })
      if (r.already === true) { setDlModelKey(null); setDlModelProgress(null); await refresh() }
      else if (r.error !== undefined) { setError(r.error); setDlModelKey(null); setDlModelProgress(null) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDlModelKey(null)
      setDlModelProgress(null)
    }
  }

  // 进度订阅 + 兜底轮询 + 挂载恢复（2026-09-09）：下载在 host 侧跑，关设置/切页面不中断、
  // 重开也能恢复显示（原先用组件内 Promise 等终态，卸载即丢进度）。
  useEffect(() => {
    if (!dlEngine && dlModelKey === null) return undefined
    const off = subscribeProgress((p) => {
      if (p.key === 'engine') {
        setDlEngineProgress(toView(p))
        if (p.status === 'done' || p.status === 'error') {
          if (p.status === 'error') setError(p.error ?? '引擎下载失败')
          setDlEngine(false)
          void refresh()
        }
      } else {
        setDlModelProgress(toView(p))
        if (p.status === 'done' || p.status === 'error') {
          if (p.status === 'error') setError(p.error ?? '模型下载失败')
          setDlModelKey(null)
          void refresh()
        }
      }
    })
    let stopped = false
    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return
        try {
          for (const key of ['engine', 'model'] as const) {
            const p = await call<{ percent: number; downloadedBytes: number; totalBytes: number; status: string; error?: string; bytesPerSecond?: number; etaSeconds?: number; target?: string }>('getDownloadProgress', { key })
            if (stopped) return
            if (p.status === 'idle') continue
            if (key === 'engine') {
              setDlEngineProgress(toView(p))
              if (p.status === 'done' || p.status === 'error') { if (p.status === 'error') setError(p.error ?? '引擎下载失败'); setDlEngine(false); void refresh() }
            } else {
              setDlModelProgress(toView(p))
              if (p.target !== undefined && dlModelKey === null) setDlModelKey(p.target)
              if (p.status === 'done' || p.status === 'error') { if (p.status === 'error') setError(p.error ?? '模型下载失败'); setDlModelKey(null); void refresh() }
            }
          }
        } catch { /* 忽略 */ }
      })()
    }, 2000)
    return () => { stopped = true; clearInterval(timer); off() }
  }, [dlEngine, dlModelKey])

  // 挂载恢复：host 侧可能已经在下载（上次关闭设置时留下的）。
  useEffect(() => {
    void (async () => {
      for (const key of ['engine', 'model'] as const) {
        try {
          const p = await call<{ percent: number; downloadedBytes: number; totalBytes: number; status: string; bytesPerSecond?: number; etaSeconds?: number; target?: string }>('getDownloadProgress', { key })
          if (p.status !== 'downloading') continue
          if (key === 'engine') { setDlEngineProgress(toView(p)); setDlEngine(true) }
          else { setDlModelProgress(toView(p)); setDlModelKey(p.target ?? '__downloading__') }
        } catch { /* 忽略 */ }
      }
    })()
  }, [])

  // 删除模型
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const deleteModel = async (fileName: string) => {
    setBusyModel(fileName)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('deleteModel', { fileName })
      if (!r.ok) setError(r.error ?? '删除失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyModel(null)
      setConfirmDelete(null)
    }
  }

  // ── 推荐模型 / 导入 / 在线目录 状态 ──
  const [recommended, setRecommended] = useState<RecommendedSdModel[]>([])
  const [importPath, setImportPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [onlineQuery, setOnlineQuery] = useState('')
  const [onlineResults, setOnlineResults] = useState<OnlineSdModel[] | null>(null)
  const [onlineSearching, setOnlineSearching] = useState(false)
  const [onlineError, setOnlineError] = useState<string | null>(null)
  const onlineSearchRef = useRef<HTMLDivElement | null>(null)

  // click-away：点击搜索区域外时收起搜索结果下拉。
  useEffect(() => {
    if (onlineResults === null) return
    const onClick = (e: MouseEvent) => {
      if (onlineSearchRef.current !== null && !onlineSearchRef.current.contains(e.target as Node)) {
        setOnlineResults(null)
        setOnlineError(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => { document.removeEventListener('mousedown', onClick) }
  }, [onlineResults])

  const refreshRecommended = async (): Promise<void> => {
    try {
      const recs = await call<RecommendedSdModel[]>('listRecommendedModels', {})
      setRecommended(recs)
    } catch { /* 忽略 */ }
  }

  useEffect(() => { void refreshRecommended() }, [status?.totalMemGb, status?.gpu])

  // 切换激活模型（单选互斥：点哪个激活哪个，全局唯一）。
  const switchActive = async (fileName: string) => {
    setBusyModel(fileName)
    setError(null)
    try {
      const r = await call<{ ok: boolean; error?: string }>('activateModel', { fileName })
      if (!r.ok) setError(r.error ?? '切换失败')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyModel(null)
    }
  }

  // 导入本地模型文件。
  const doImport = async () => {
    const p = importPath.trim()
    if (p === '') return
    setImporting(true)
    setError(null)
    try {
      const r = await call<{ ok: boolean; fileName?: string; error?: string }>('importModel', { sourcePath: p })
      if (!r.ok) { setError(r.error ?? '导入失败'); return }
      setImportPath('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  // 在线目录搜索。
  const doOnlineSearch = async () => {
    setOnlineSearching(true)
    setOnlineError(null)
    try {
      const r = await call<{ results: OnlineSdModel[]; error?: string }>('searchOnlineModels', { query: onlineQuery })
      if (r.error !== undefined && r.results.length === 0) { setOnlineResults([]); setOnlineError(r.error) }
      else setOnlineResults(r.results)
    } catch (e) {
      setOnlineResults([])
      setOnlineError(e instanceof Error ? e.message : String(e))
    } finally {
      setOnlineSearching(false)
    }
  }

  // 下载在线模型（后台下载；进度走事件 + 兜底轮询，与引擎/推荐模型同一套）。
  const downloadOnline = async (m: OnlineSdModel) => {
    setDlModelKey(m.fileName)
    setError(null)
    setDlModelProgress({ percent: 0, total: '0 B', downloaded: '0 B', status: 'downloading' })
    try {
      const r = await call<{ started: boolean; already?: boolean; error?: string }>('downloadModelFromUrl', { url: m.downloadUrl, fileName: m.fileName })
      if (r.already === true) { setDlModelProgress(null); setDlModelKey(null); await refresh() }
      else if (r.error !== undefined) { setError(r.error); setDlModelProgress(null); setDlModelKey(null) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDlModelProgress(null)
      setDlModelKey(null)
    }
  }

  // 断点残片（fileName → 字节）：>0 时按钮显示「继续下载」。
  const partialOf = (fileName: string): number => status?.partials?.find(p => p.fileName === fileName)?.bytes ?? 0

  // 当前激活模型（生成唯一使用）。
  const activeModel = status?.models.find(m => m.active === true)

  const generate = async (): Promise<void> => {
    if (prompt.trim() === '') return
    if (status === null || !status.engineBundled || activeModel === undefined) return
    setGenerating(true)
    setError(null)
    setResultImage(null)
    setGenDuration(null)
    setGenProgress(0)
    try {
      // 不指定 model → host 用当前激活模型（互斥后的唯一生效模型）。
      const args: Txt2ImgArgs = { prompt: prompt.trim(), width: size, height: size, steps }
      const { jobId } = await call<{ jobId: string }>('startTxt2Img', { args: args as unknown as Record<string, unknown> })
      // P2-7：进度走 `$on('corum/artgen/job-progress')` 推送（取代 400ms 轮询）；
      // 终态帧不带结果图，故 done 后用一次 getTxt2ImgJob 取 result。
      let settle: ((p: ArtgenJobProgressEvent) => void) | null = null
      const terminal = new Promise<ArtgenJobProgressEvent>((resolve) => { settle = resolve })
      const off = subscribeJobProgress((p) => {
        if (p.jobId !== jobId) return
        setGenProgress(p.percent)
        if (p.status === 'done' || p.status === 'error') settle?.(p)
      })
      try {
        const final = await terminal
        if (final.status === 'error') throw new Error(final.error ?? '生成失败')
        const job = await call<Txt2ImgJob | null>('getTxt2ImgJob', { jobId })
        if (job?.result !== undefined) {
          setResultImage(job.result.imageBase64)
          setGenDuration(job.result.durationMs)
        }
        setGenProgress(100)
      } finally {
        off()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  const engineReady = status !== null && status.engineBundled && status.meetsMinReq
  const canGenerate = engineReady && activeModel !== undefined && !generating && prompt.trim() !== ''

  const TIER_LABEL: Record<RecommendedSdModel['tier'], string> = { low: '低配', mid: '中配', high: '高配' }
  const tierOf = (m: RecommendedSdModel) => m.tier

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <Row label="本地文生图（Art Generator）" desc="基于 stable-diffusion.cpp 单体二进制，三平台本地文生图（macOS / Windows / Linux）" />

      {/* ── 引擎状态 ── */}
      <Row label="引擎状态" desc="sd-cli 是否已下载到本地 · 硬件配置检测">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: 10,
          border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
        }}>
          {status === null ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>检测中…</span>
          ) : !status.meetsMinReq ? (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-state-error-primary)',
                border: '1px solid var(--dsw-alias-state-error-primary)',
              }}>⚠ 配置不足</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }}>
                {status.minReqReason ?? '硬件配置不满足要求'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                {platformName(status.platform)} · {status.cpuCores} 核 · 内存 {status.totalMemGb} GB
                {status.gpu !== null ? ` · GPU ${status.gpu.name} · ${status.gpu.vramGb} GB VRAM` : ' · 无独立 GPU（CPU 推理可用但慢）'}
              </span>
            </>
          ) : engineReady ? (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-state-success-primary)',
                border: '1px solid var(--dsw-alias-state-success-primary)',
              }}>● 就绪</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
                引擎已就绪 · {status.models.length} 个模型 · {platformName(status.platform)} · {status.cpuCores} 核 · 内存 {status.totalMemGb} GB
                {status.gpu !== null ? ` · GPU ${status.gpu.name}` : ' · CPU 推理'}
              </span>
              <span style={{ ...MONO, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{status.enginePath}</span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                color: 'var(--dsw-alias-label-dimmed)',
                border: '1px solid var(--corum-glass-border)',
              }}>○ 未下载</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>引擎未下载到本地</span>
              <button type="button" disabled={dlEngine} onClick={() => void downloadEngine()} style={{
                padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: dlEngine ? 'wait' : 'pointer',
                border: '1px solid var(--corum-glass-border-active)', background: 'var(--corum-glass-3)',
                color: 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap',
              }}>{dlEngine
                ? '下载中…'
                : partialOf('sd-cli-download.zip') > 0
                  ? `继续下载（已下载 ${formatBytesClient(partialOf('sd-cli-download.zip'))}）`
                  : '下载引擎到本地'}</button>
            </>
          )}
        </div>
        <DownloadProgressBar progress={dlEngineProgress} />
        {/* ── 常驻模式开关 ── */}
        {resident !== null && engineReady && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8,
            padding: '10px 12px', borderRadius: 10,
            border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
          }}>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
              color: resident.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-dimmed)',
              border: `1px solid ${resident.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--corum-glass-border)'}`,
            }}>{resident.enabled ? (resident.running ? `● 常驻中 · ${resident.model ?? ''}` : '● 常驻模式') : '○ 进程式'}</span>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flex: 1 }}>
              {resident.enabled
                ? '模型常驻内存，生成免冷加载（首次拉起需数秒加载）'
                : resident.serverBundled
                  ? '开启常驻模式：激活模型常驻内存，省去每次生成的冷加载'
                  : '常驻模式需要 sd-server（重新下载引擎可补齐）'}
            </span>
            <button type="button" disabled={residentBusy || !resident.serverBundled} onClick={() => void toggleResident(!resident.enabled)} style={{
              padding: '5px 12px', borderRadius: 8, fontSize: 12, cursor: residentBusy || !resident.serverBundled ? 'not-allowed' : 'pointer',
              border: '1px solid var(--corum-glass-border-active)', background: resident.enabled ? 'transparent' : 'var(--corum-glass-3)',
              color: resident.enabled ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)', whiteSpace: 'nowrap',
              opacity: resident.serverBundled ? 1 : 0.5,
            }}>{residentBusy ? '切换中…' : resident.enabled ? '关闭常驻' : '开启常驻'}</button>
          </div>
        )}
      </Row>

      {/* ── 推荐模型（低/中/高配，含参数）── */}
      <Row label="推荐模型" desc="按硬件档位推荐 · 显示架构 / 量化 / 大小 / VRAM / 推荐步数">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {recommended.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>加载推荐…</span>
          ) : recommended.map(m => {
            const downloaded = status?.models.some(x => x.fileName === m.fileName) ?? false
            const thisDownloading = dlModelKey === m.tier || dlModelKey === m.fileName
            const anyDownloading = dlModelKey !== null
            // Flux 行：主模型在、但配套（VAE/文本编码器）缺 → 「补齐依赖」（否则生成必失败）
            const isFlux = m.architecture === 'Flux'
            const enc = status?.textEncoders ?? { clipL: true, t5xxl: true }
            const needsCompanion = downloaded && isFlux && (!enc.clipL || !enc.t5xxl)
            const disabled = anyDownloading || !engineReady || downloaded || m.compatible === false
            return (
              <div key={m.fileName} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                borderRadius: 8, border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
                opacity: m.compatible === false ? 0.6 : 1,
              }}>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                  color: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--corum-glass-border-active)',
                }}>{TIER_LABEL[tierOf(m)]}</span>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{m.name}</span>
                    <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.architecture}</span>
                    <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.quantization}</span>
                    <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.size}</span>
                    <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>VRAM {m.vramGb}GB</span>
                    <span style={{ fontSize: 10, color: 'var(--dsw-alias-brand-primary)' }}>{m.recommendedSteps} 步 · {m.recommendedSize}px</span>
                  </div>
                  <span style={{ fontSize: 11, color: m.compatible === false ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)' }}>
                    {m.description}{m.incompatibleReason !== undefined ? ` · ⚠ ${m.incompatibleReason}` : ''}
                    {needsCompanion ? ' · ⚠ 缺少文本编码器（Flux 必需，否则生成失败）' : ''}
                  </span>
                </div>
                {downloaded && !needsCompanion
                  ? <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'nowrap' }}>✓ 已下载</span>
                  : <button type="button" disabled={disabled} onClick={() => void downloadModel(m.tier)} style={{
                      padding: '5px 12px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                      background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
                      cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1,
                    }}>{thisDownloading
                      ? '下载中…'
                      : partialOf(m.fileName) > 0
                        ? `继续下载（${formatBytesClient(partialOf(m.fileName))}）`
                        : downloaded
                          ? '补齐依赖（约 2.2 GB）'
                          : '下载'}</button>}
              </div>
            )
          })}
        </div>
        <DownloadProgressBar progress={dlModelProgress} />
      </Row>

      {/* ── 已下载模型（单选切换，有且仅一个激活）── */}
      <Row label="已下载模型" desc="点选切换当前生成模型 · 有且仅一个生效 · 生成即用激活模型">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {status === null ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>加载中…</span>
          ) : status.models.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>暂无模型 — 从推荐模型下载，或下方导入本地文件 / 在线目录下载</span>
          ) : (
            status.models.map(m => {
              const isActive = m.active === true
              const busy = busyModel === m.fileName
              return (
                <div key={m.fileName} onClick={() => { if (!isActive && !busy) void switchActive(m.fileName) }} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                  borderRadius: 8, cursor: isActive ? 'default' : 'pointer',
                  border: `1px solid ${isActive ? 'var(--corum-glass-border-active)' : 'var(--corum-glass-border)'}`,
                  background: isActive ? 'var(--corum-glass-3)' : 'var(--corum-glass-2)',
                }}>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap', fontWeight: 600,
                    color: isActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-dimmed)',
                    border: `1px solid ${isActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--corum-glass-border)'}`,
                  }}>{isActive ? '● 使用中' : '○'}</span>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{m.displayName}</span>
                      {m.architecture !== undefined && <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.architecture}</span>}
                      {m.quantization !== undefined && <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.quantization}</span>}
                      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{m.size}</span>
                      {m.vramGb !== undefined && <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>VRAM {m.vramGb}GB</span>}
                      {m.recommendedSteps !== undefined && <span style={{ fontSize: 10, color: 'var(--dsw-alias-brand-primary)' }}>{m.recommendedSteps} 步 · {m.recommendedSize}px</span>}
                    </div>
                    <span style={{ ...MONO, fontSize: 10, color: 'var(--dsw-alias-label-dimmed)' }}>{m.fileName}</span>
                  </div>
                  {confirmDelete === m.fileName ? (
                    <span style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                      <button type="button" disabled={busy} onClick={() => void deleteModel(m.fileName)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary)',
                        background: 'var(--dsw-alias-state-error-primary)', color: '#fff', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                      }}>确认删除</button>
                      <button type="button" onClick={() => setConfirmDelete(null)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>取消</button>
                    </span>
                  ) : (
                    <button type="button" disabled={busy} onClick={e => { e.stopPropagation(); setConfirmDelete(m.fileName) }} style={{
                      padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                      background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                    }}>{busy ? '处理中…' : '删除'}</button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Row>

      {/* ── 导入本地模型 ── */}
      <Row label="导入本地模型" desc="把本机已有的 .safetensors / .gguf 模型文件复制进模型目录">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none', ...MONO,
            }}
            placeholder="模型文件绝对路径（如 /Users/…/model.safetensors）"
            value={importPath}
            onChange={e => setImportPath(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doImport() }}
          />
          <button type="button" disabled={importing || importPath.trim() === ''} onClick={() => void doImport()} style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: importing || importPath.trim() === '' ? 'not-allowed' : 'pointer',
            border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)',
            color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap', opacity: importing || importPath.trim() === '' ? 0.5 : 1,
          }}>{importing ? '导入中…' : '导入'}</button>
        </div>
      </Row>

      {/* ── 在线模型目录 ── */}
      <Row label="在线模型目录" desc="搜索 HuggingFace 官方/社区 SD 模型，一键下载使用">
        <div ref={onlineSearchRef}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none',
            }}
            placeholder="搜索模型（如 dreamshaper、realistic、anime、flux…）"
            value={onlineQuery}
            onChange={e => setOnlineQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doOnlineSearch() }}
          />
          <button type="button" disabled={onlineSearching} onClick={() => void doOnlineSearch()} style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, cursor: onlineSearching ? 'wait' : 'pointer',
            border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)',
            color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap',
          }}>{onlineSearching ? '搜索中…' : '搜索'}</button>
        </div>
        {onlineError !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6, display: 'block' }}>{onlineError}</span>}
        {onlineResults !== null && onlineResults.length === 0 && onlineError === null && (
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>无结果</span>
        )}
        {onlineResults !== null && onlineResults.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {onlineResults.map(m => {
              const downloaded = status?.models.some(x => x.fileName === m.fileName) ?? false
              const thisDownloading = dlModelKey === m.fileName
              const anyDownloading = dlModelKey !== null
              const disabled = anyDownloading || !engineReady
              return (
                <div key={m.repoId} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                  borderRadius: 8, border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)',
                }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{m.name}</span>
                      <span style={{ ...MONO, fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-tertiary)' }}>{m.architecture}</span>
                      <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>↓{m.downloads} · ♥{m.likes}</span>
                    </div>
                    <span style={{ ...MONO, fontSize: 10, color: 'var(--dsw-alias-label-dimmed)' }}>{m.repoId} · {m.fileName}</span>
                  </div>
                  {downloaded
                    ? <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'nowrap' }}>✓ 已下载</span>
                    : <button type="button" disabled={disabled} onClick={() => void downloadOnline(m)} style={{
                        padding: '4px 10px', borderRadius: 8, border: '1px solid var(--corum-glass-border)',
                        background: 'var(--corum-glass-3)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
                        cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1,
                      }}>{thisDownloading
                        ? '下载中…'
                        : partialOf(m.fileName) > 0
                          ? `继续下载（${formatBytesClient(partialOf(m.fileName))}）`
                          : '下载'}</button>}
                </div>
              )
            })}
          </div>
        )}
        </div>
      </Row>

      {/* ── 生成测试 ── */}
      <Row label="生成测试" desc={activeModel !== undefined ? `使用模型：${activeModel.displayName}（${activeModel.architecture ?? 'SD'}）` : '请先在「已下载模型」里点选一个模型'}>
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px',
          borderRadius: 12, border: '1px solid var(--corum-glass-border)',
          background: 'var(--corum-glass-2)',
        }}>
          <textarea
            style={{
              width: '100%', minHeight: 64, padding: '8px 10px', borderRadius: 8, fontSize: 12,
              border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-1, transparent)',
              color: 'var(--dsw-alias-label-primary)', outline: 'none', resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
            placeholder="输入提示词（如：a cute cat, digital art, highly detailed）"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            disabled={generating}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginRight: 2 }}>尺寸</span>
            {SIZES.map(s => (
              <button key={s} type="button" disabled={generating} onClick={() => setSize(s)} style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: generating ? 'not-allowed' : 'pointer',
                border: '1px solid var(--corum-glass-border)',
                background: size === s ? 'var(--corum-glass-3)' : 'transparent',
                color: size === s ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                fontWeight: size === s ? 600 : 400, whiteSpace: 'nowrap',
              }}>{s}×{s}</button>
            ))}
            <span style={{ flex: 1 }} />
            <label style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', display: 'flex', alignItems: 'center', gap: 4 }}>
              步数
              <input type="number" min={1} max={100} value={steps} disabled={generating}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  setSteps(Number.isNaN(v) ? 20 : Math.max(1, Math.min(100, v)))
                }}
                style={{
                  width: 56, padding: '4px 6px', borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-1, transparent)',
                  color: 'var(--dsw-alias-label-primary)', outline: 'none', ...MONO,
                }}
              />
            </label>
            <button type="button" disabled={!canGenerate} onClick={() => void generate()} style={{
              padding: '6px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: canGenerate ? 'pointer' : 'not-allowed',
              border: '1px solid var(--corum-glass-border-active)', background: 'var(--dsw-alias-brand-primary)',
              color: 'var(--corum-label-on-brand, #fff)', whiteSpace: 'nowrap',
              opacity: canGenerate ? 1 : 0.5,
            }}>{generating ? '生成中…' : (activeModel === undefined ? '请先选模型' : '生成')}</button>
          </div>
          {/* 生成进度条 */}
          {generating && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
                <div style={{
                  width: `${genProgress}%`, height: '100%', borderRadius: 3,
                  background: 'var(--dsw-alias-brand-primary)', transition: 'width 0.3s ease',
                }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 36, textAlign: 'right' }}>{genProgress}%</span>
            </div>
          )}
          {/* 结果预览 */}
          {resultImage !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <img src={`data:image/png;base64,${resultImage}`} alt="生成结果"
                style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--corum-glass-border)' }} />
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                {genDuration !== null && <span>耗时：{(genDuration / 1000).toFixed(1)}s</span>}
                <span>{size}×{size} · {steps} 步{activeModel !== undefined ? ` · ${activeModel.displayName}` : ''}</span>
              </div>
            </div>
          )}
        </div>
      </Row>

      {error !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>}
    </div>
  )
}

export const inject = ['slots', 'connection', 'remote']

export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  // P2-7：下载进度推送订阅面（renderer 侧 $on；host 在 downloadSlots 每次写入时 emit）。
  const subscribeProgress = (listener: (p: ArtgenDownloadProgressEvent) => void): (() => void) =>
    ctx.remote.$on('corum/artgen/download-progress', listener)
  const subscribeJobProgress = (listener: (p: ArtgenJobProgressEvent) => void): (() => void) =>
    ctx.remote.$on('corum/artgen/job-progress', listener)
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'artgen',
    order: 197,
    label: '本地文生图',
  }, () => <ArtGenSection call={call} subscribeProgress={subscribeProgress} subscribeJobProgress={subscribeJobProgress} />))
}
