/**
 * NotificationHost — corum-desktop 通知的渲染层（design.pen「row-通知框」YbfO9，
 * 深色 g5jAt / 浅色 QEM1e；收起态见「Session 顶栏 · Agent 胶囊融合」③ 与
 * `drawer-tab` cZ9D4）。
 *
 * 结构 = 设计稿 toast 单行四元素（横向 gap 9、padding 10/12、宽 340、圆角 14）：
 *   ① 状态图标 16（lucide circle-check / hourglass / circle-alert / info，
 *      颜色 $state-*-primary / brand）
 *   ② col（fill_container，纵向 gap 2）：title 12/600 $label-primary +
 *      msg 10.5 $label-secondary（无 msg 时只渲染标题）
 *   ③ 相对时间（JetBrains Mono 9.5 $label-tertiary）
 *   ④ 关闭 ×（16 框内 9 图标，$label-tertiary）
 * 底 $glass-1 + 外阴影 0 10 28 #0000003D；**设计稿无描边、无操作行**——2026-09-09
 * 对齐时删掉了旧的 icon-box 与 r2 操作行（无消费方，见 notifications.ts）。
 *
 * 2026-09-10 用户定调「有通知弹出后，5s 未处理自动收起到右下角」：未处理的 toast
 * 计时 5s 后收起为右下角常驻 bell（`drawer-tab`），点 bell 展开通知中心；
 * 鼠标悬停 toast 期间暂停计时（进度条同步冻结，二者共用同一剩余时间）。
 *
 * 2026-09-10 第二轮（用户「继续完成剩余内容」，TODO 两条待办）：
 *   ① **bell 可拖动 + 边缘吸附**：松手吸附最近边缘（左右为主，必要时上下），
 *      位置持久化（store → localStorage），吸附后圆角朝向跟随边缘；拖动中不触发展开
 *      （用 6px 移动阈值区分 click 与 drag）。
 *   ② **通知交互**：通知中心头部「全部已读」（未读清零 → bell 隐藏）+ 手动收起浮窗
 *      （与 5s 自动收起共用 `collapsed` 状态机）+ toast 底部 4px **倒计时进度条**
 *      （随 5s 线性收缩，悬停冻结）。
 *
 * 通知栈经 createPortal 挂到 document.body 右下角（摆脱网格 .leaf 的
 * will-change:transform + overflow:hidden 合成层裁剪，同 SettingsShell 模式）。
 * @module corum-desktop/client/NotificationHost
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Bell, CircleAlert, CircleCheck, Hourglass, Info, X } from 'lucide-react'
import type { BellPosition, CorumNotification, NotificationStore, NotificationTone } from './notifications.ts'
import css from './NotificationHost.module.css'

/** 未处理自动收起的等待时长（用户定调 5s）。 */
export const AUTO_COLLAPSE_MS = 5000

/** 拖动判定阈值（px）：位移超过它才算拖动，否则视为点击展开。 */
const DRAG_THRESHOLD = 6

/** 吸附判定：边缘留白（px）。 */
const SNAP_MARGIN = 16

/** 拖到边缘附近多少 px 内就吸附该边（左右优先）。 */
const SNAP_ATTRACT = 96

/** 吸附后沿轴的最小偏移，避免贴到视口角落被裁。 */
const AXIS_MIN = 72

/** tone → lucide 图标（设计稿：success=circle-check / warn=hourglass / error=circle-alert）。 */
const TONE_ICON: Record<NotificationTone, typeof Info> = {
  success: CircleCheck,
  warn: Hourglass,
  error: CircleAlert,
  info: Info,
}

/** tone → 状态色类（显式映射，避免动态键在 CSS Modules 下失配）。 */
const TONE_CLASS: Record<NotificationTone, string> = {
  success: css.toneSuccess,
  warn: css.toneWarn,
  error: css.toneError,
  info: css.toneInfo,
}

/** r3 行时间戳的相对时间标签（对齐侧栏 timeLabel 语义，设计稿示例「2 分钟前」）。 */
function relTime(createdAt: number): string {
  const diff = Date.now() - createdAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** tone → 进度条配色类（与状态图标同色系）。 */
const BAR_CLASS: Record<NotificationTone, string> = {
  success: css.barSuccess,
  warn: css.barWarn,
  error: css.barError,
  info: css.barInfo,
}

/**
 * bell 的定位样式：贴边 + 沿轴偏移；圆角朝向跟随边缘（贴右=左侧圆角）。
 * @param position - 当前吸附位置。
 * @returns 内联样式（含 `data-edge` 由调用方设置）。
 */
function bellStyle(position: BellPosition): React.CSSProperties {
  switch (position.edge) {
    case 'right': return { right: 0, top: position.offset }
    case 'left': return { left: 0, top: position.offset }
    case 'top': return { top: 0, left: position.offset }
    case 'bottom': return { bottom: 0, left: position.offset }
  }
}

/**
 * 把拖动落点吸附到最近边缘（左右优先，因为通知栈在右侧）。
 * @param x - 落点中心 x（视口坐标）。
 * @param y - 落点中心 y。
 * @param width - 视口宽。
 * @param height - 视口高。
 * @returns 吸附后的位置。
 */
function snapToEdge(x: number, y: number, width: number, height: number): BellPosition {
  const distLeft = x
  const distRight = width - x
  const distTop = y
  const distBottom = height - y
  const min = Math.min(distLeft, distRight, distTop, distBottom)
  // 左右优先：上下的距离必须明显更近才吸附上下（否则拖到角落时会翻成上下）。
  if (min === distLeft || min === distRight) {
    return {
      edge: distLeft < distRight ? 'left' : 'right',
      offset: Math.max(AXIS_MIN, Math.min(height - AXIS_MIN, y)),
    }
  }
  return {
    edge: distTop < distBottom ? 'top' : 'bottom',
    offset: Math.max(AXIS_MIN, Math.min(width - AXIS_MIN, x)),
  }
}

function Toast({ notification, paused, onCollapse, onDismiss, onOpen }: {
  notification: CorumNotification
  paused: boolean
  onCollapse: (id: string) => void
  onDismiss: (id: string) => void
  /** 点击整条 → 打开来源会话（无 onOpen 时不可点）。 */
  onOpen: (id: string) => void
}) {
  const Icon = TONE_ICON[notification.tone]
  const clickable = notification.onOpen !== undefined
  // 5s 未处理 → 收起；悬停暂停（清除计时 + 冻结进度条），移开后按**剩余时间**续计。
  //
  // 剩余时间用 `remainingRef` 而非 state：进度条的宽度靠 CSS 动画表达（见 .countdown），
  // 不必每帧重渲染；这里只需要在「暂停/恢复」边界读到准确的剩余毫秒。
  const remainingRef = useRef(AUTO_COLLAPSE_MS)
  const deadlineRef = useRef(0)
  const [progressPaused, setProgressPaused] = useState(paused)
  useEffect(() => {
    if (paused) {
      // 暂停：结算剩余时间并冻结进度条宽度。
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now())
      setProgressPaused(true)
      return undefined
    }
    // 恢复：从剩余时间续计（首次进入时 remaining 即满额 5s）。
    deadlineRef.current = Date.now() + remainingRef.current
    setProgressPaused(false)
    const timer = setTimeout(() => { onCollapse(notification.id) }, remainingRef.current)
    return () => { clearTimeout(timer) }
  }, [paused, notification.id, onCollapse])
  return (
    <div
      className={css.toast}
      data-tone={notification.tone}
      data-action={clickable || undefined}
      role="status"
      onClick={clickable ? () => { onOpen(notification.id) } : undefined}
    >
      <Icon size={16} strokeWidth={2} className={`${css.toneIcon} ${TONE_CLASS[notification.tone]}`} />
      <div className={css.col}>
        <span className={css.title}>{notification.title}</span>
        {notification.message !== undefined && notification.message !== '' && (
          <span className={css.msg}>{notification.message}</span>
        )}
      </div>
      <span className={css.time}>{relTime(notification.createdAt)}</span>
      <button
        type="button"
        className={css.btnX}
        aria-label="关闭通知"
        onClick={() => onDismiss(notification.id)}
      >
        <X size={9} strokeWidth={2} />
      </button>
      {/* 倒计时进度条（4px）：5s 线性收缩；悬停冻结（animation-play-state: paused）。 */}
      <span
        className={`${css.countdown} ${BAR_CLASS[notification.tone]}`}
        data-paused={progressPaused || undefined}
        style={{ '--corum-countdown': `${AUTO_COLLAPSE_MS}ms` } as React.CSSProperties}
        aria-hidden="true"
      />
    </div>
  )
}

/**
 * 通知中心（展开列表）：头部「全部已读」+「收起」+ 逐条渲染（可单条关闭）。
 * @param props - 通知列表与三个动作回调。
 * @returns 右侧抽屉式面板。
 */
function NotificationPanel({ items, onMarkAllRead, onClose, onDismiss, onOpen }: {
  items: readonly CorumNotification[]
  onMarkAllRead: () => void
  onClose: () => void
  onDismiss: (id: string) => void
  onOpen: (id: string) => void
}) {
  const unread = items.filter(n => !n.read).length
  return (
    <div className={css.panel} role="dialog" aria-label="通知中心">
      <div className={css.panelHead}>
        <Bell size={14} strokeWidth={2} className={css.panelHeadIcon} />
        <span className={css.panelTitle}>通知</span>
        {unread > 0 && <span className={css.panelUnread}>{unread}</span>}
        <span className={css.panelSpacer} />
        {unread > 0 && (
          <button type="button" className={css.panelAction} onClick={onMarkAllRead}>
            全部已读
          </button>
        )}
        <button
          type="button"
          className={css.panelIconBtn}
          aria-label="收起通知中心"
          title="收起"
          onClick={onClose}
        >
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      <div className={css.panelBody}>
        {items.length === 0 && <span className={css.panelEmpty}>暂无通知</span>}
        {items.map(n => {
          const Icon = TONE_ICON[n.tone]
          return (
            <div
              key={n.id}
              className={css.panelRow}
              data-read={n.read || undefined}
              data-tone={n.tone}
              data-action={n.onOpen !== undefined || undefined}
              onClick={n.onOpen === undefined ? undefined : () => { onOpen(n.id) }}
            >
              <Icon size={14} strokeWidth={2} className={`${css.toneIcon} ${TONE_CLASS[n.tone]}`} />
              <div className={css.col}>
                <span className={css.title}>{n.title}</span>
                {n.message !== undefined && n.message !== '' && <span className={css.msg}>{n.message}</span>}
              </div>
              <span className={css.time}>{relTime(n.createdAt)}</span>
              <button
                type="button"
                className={css.btnX}
                aria-label="关闭通知"
                onClick={() => onDismiss(n.id)}
              >
                <X size={9} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 通知宿主的渲染档位。
 *
 * - `full`（主窗默认）：toast 栈 + 可拖动 bell + 通知中心。承载**全局**通知
 *   （编排进度、子 Agent 完成、工作区回收…），未读数是其核心状态。
 * - `direct`（浮窗）：**只有 toast 栈**，不渲染 bell、不渲染通知中心。
 *
 * 为什么分档（用户 2026-09-10 定调）：「通知只归属主窗口」+「保留浮窗的直接反馈」。
 * 全局事件桥在浮窗根本不安装（见 notification-bridge.ts），浮窗里能出现的只有
 * **本窗口用户动作的直接反馈**（`__corumNotify`：切换 Agent 失败、编辑器打开失败…）。
 * 这类反馈是「我刚才那一下的结果」，必须当场看见 → 保留 toast；而「通知中心 /
 * 未读数」是应用级的信箱心智，浮窗是个可能很小、随时会被关掉的单槽位视图，
 * 在那里再立一个信箱只会和主窗的未读数打架 → 不渲染 bell。
 */
export type NotificationHostMode = 'full' | 'direct'

/**
 * 通知栈宿主：portal 到 body 右下角纵向堆叠（设计稿 alignItems=end）+ 可拖动 bell + 通知中心。
 * @param props - 通知 store 与渲染档位（默认 `full`）。
 */
export function NotificationHost({ store, mode = 'full' }: { store: NotificationStore; mode?: NotificationHostMode }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [paused, setPaused] = useState(false)
  // 非 items 的 UI 状态（通知中心开合 / bell 位置）：单独订阅，避免拖动时重建 items 数组。
  const ui = useSyncExternalStore(store.subscribeUi, store.getUiSnapshot)
  const panelOpen = ui.panelOpen
  const bellPosition = ui.bell
  // 拖动中的临时位置（视口坐标；松手吸附后清空）。
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const draggedRef = useRef(false)
  const tabRef = useRef<HTMLButtonElement | null>(null)
  // 回调引用稳定：Toast 的计时 effect 依赖它们，内联箭头函数会让每次渲染都重置 5s 计时。
  //
  // direct 档的「5s 到点」= **直接销毁**（而不是收起到 bell）：浮窗没有 bell 可收，
  // 若照旧走 collapse，条目会永远留在 store 的 collapsed 状态里——既占内存，又让
  // `items.length > 0` 恒真。而直接反馈的语义本就是「当场看见」：看过即走，
  // 不沉淀成待办队列（真要留痕的失败在浮窗里另有原地错误态，如 Agent 切换失败）。
  const onCollapse = useRef((id: string) => {
    if (mode === 'direct') store.dismiss(id)
    else store.collapse(id)
  }).current
  const onDismiss = useRef((id: string) => { store.dismiss(id) }).current
  const onMarkAllRead = useRef(() => { store.markAllRead() }).current
  const onClosePanel = useRef(() => { store.setPanelOpen(false) }).current
  const onOpenNotification = useRef((id: string) => {
    // 点击 = 已确认：先标该条已读，再收起通知中心，然后执行通知自带的跳转动作。
    // 顺序重要：跳转会切会话，通知中心留在原地会挡视线，故先收起再跳。
    store.markRead(id)
    store.open(id)
    store.setPanelOpen(false)
  }).current
  /**
   * 打开通知中心（点 bell / 托盘菜单）。
   *
   * **不再 `expandAll()`**（2026-09-12 用户实测后定调「取消列表默认在浮窗操作」）：
   * 面板本身就把全部条目列出来了（含 5s 已收起的），再把它们一次性展开，等于点一下
   * bell 就让**所有**历史条目一起冒回浮窗；点列表中任意一条时面板关闭，那些条目留在
   * 浮窗里继续杵着（用户原话：「右侧列表点一个，下方会弹出所有浮窗」）。实测复现：
   * 5 条通知 → 点 bell 后浮窗 5 条 → 点其中一条后面板关了、浮窗仍是 5 条。
   * 浮窗从此只表达「刚发生、还没处理的事」：收起状态由各自的 5s 计时与用户操作决定，
   * 打开列表不动它。需要「把历史全部摊开」时再给显式动作（`store.expandAll()` 仍在）。
   */
  const onOpenPanel = useRef(() => {
    store.setPanelOpen(true)
  }).current

  /**
   * 拖动 bell：pointer 捕获 + 6px 阈值（阈值内视为点击 → 展开通知中心）。
   * 松手吸附最近边缘并持久化；拖动中不打开通知中心。
   */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // 只响应主键（右键/中键不拖）。
    if (event.button !== 0) return
    const el = event.currentTarget
    const rect = el.getBoundingClientRect()
    const grab = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    draggedRef.current = false
    const start = { x: event.clientX, y: event.clientY }
    let moved: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent): void => {
      const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y)
      if (!draggedRef.current && dist < DRAG_THRESHOLD) return
      draggedRef.current = true
      moved = {
        x: Math.max(0, Math.min(window.innerWidth - rect.width, e.clientX - grab.dx)),
        y: Math.max(0, Math.min(window.innerHeight - rect.height, e.clientY - grab.dy)),
      }
      setDragPos(moved)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (!draggedRef.current) {
        setDragPos(null)
        return
      }
      // 吸附：用 bell 中心点算最近边缘。
      const base = moved ?? { x: rect.left, y: rect.top }
      const centerX = base.x + rect.width / 2
      const centerY = base.y + rect.height / 2
      store.setBellPosition(snapToEdge(centerX, centerY, window.innerWidth, window.innerHeight))
      setDragPos(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [store])

  // 窗口缩放后把 offset 夹回可见范围（否则可能被推出屏幕）。
  useLayoutEffect(() => {
    const clamp = (): void => {
      const current = store.getBellPosition()
      const max = current.edge === 'left' || current.edge === 'right' ? window.innerHeight : window.innerWidth
      const offset = Math.max(AXIS_MIN, Math.min(max - AXIS_MIN, current.offset))
      if (offset !== current.offset) store.setBellPosition({ edge: current.edge, offset })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => { window.removeEventListener('resize', clamp) }
  }, [store])

  // Esc 收起通知中心（与手动收起同路径）。
  useEffect(() => {
    if (!panelOpen) return undefined
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') store.setPanelOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [panelOpen, store])

  if (items.length === 0) return null
  const unread = items.filter(n => !n.read).length
  const visible = items.filter(n => !n.collapsed)
  /**
   * bell 的渲染条件（2026-09-10 调整）。
   *
   * 原实现（照抄 TODO 的「无未读时不渲染 bell」）只在**有未读**时出现——结果是
   * 通知栏在日常使用中根本找不到：事件没触发时它不存在，全部已读后它又消失。
   * 用户反馈「我怎么没看到通知栏呢」正是这个结构性问题的表现。
   *
   * 现改为：**只要有通知记录就渲染 bell**（读过的也留着），徽标只在有未读时显示。
   * 这样通知中心恒可达（可回看历史），同时「未读」的视觉强调不变——比「隐藏」更
   * 符合通知中心的心智模型（设计稿的 drawer-tab 本就是常驻图标，未读数是其附加态）。
   */
  const showBell = mode === 'full' && items.length > 0 && !panelOpen
  const dragStyle: React.CSSProperties | undefined = dragPos === null
    ? undefined
    : { left: dragPos.x, top: dragPos.y, right: 'auto', bottom: 'auto' }
  return createPortal(
    <>
      {visible.length > 0 && (
        <div
          className={css.stack}
          aria-live="polite"
          onMouseEnter={() => { setPaused(true) }}
          onMouseLeave={() => { setPaused(false) }}
        >
          {visible.map(n => (
            <Toast
              key={n.id}
              notification={n}
              paused={paused}
              onCollapse={onCollapse}
              onDismiss={onDismiss}
              onOpen={onOpenNotification}
            />
          ))}
        </div>
      )}
      {panelOpen && mode === 'full' && (
        <NotificationPanel
          items={items}
          onMarkAllRead={onMarkAllRead}
          onClose={onClosePanel}
          onDismiss={onDismiss}
          onOpen={onOpenNotification}
        />
      )}
      {showBell && (
        <button
          ref={tabRef}
          type="button"
          className={css.tab}
          data-edge={bellPosition.edge}
          data-dragging={dragPos !== null || undefined}
          aria-label={unread > 0 ? `通知（${unread} 条未读）；可拖动到屏幕边缘` : '通知中心；可拖动到屏幕边缘'}
          title={unread > 0 ? `${unread} 条未读通知（可拖动）` : `${items.length} 条通知（可拖动）`}
          style={dragStyle ?? bellStyle(bellPosition)}
          onPointerDown={onPointerDown}
          onClick={() => {
            // 拖动过就不要再触发展开（指针抬起后浏览器仍会补一次 click）。
            if (draggedRef.current) { draggedRef.current = false; return }
            onOpenPanel()
          }}
        >
          <Bell size={18} strokeWidth={2} className={css.tabIcon} />
          {unread > 0 && <span className={css.tabBadge}>{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    </>,
    document.body,
  )
}
