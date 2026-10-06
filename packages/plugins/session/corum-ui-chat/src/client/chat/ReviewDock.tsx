// fork（corum）：Review 卡（文件更改审查）的 dock 槽入口。
//
// 为什么是槽注册而不是 portal（2026-09-11 重构）：
// 早先 Review 卡在 ChatView 内部渲染，为了让它不随消息滚动，曾用
// `document.querySelector('[data-composer-seat] [class*="composerStack"]')` +
// `createPortal` 把节点搬进 composer 座位的吸附容器。那是跨插件边界捞宿主
// DOM，`composerStack` 改名就会静默失效（卡片不显示、且不报错）。
// 现改为与 TodoPanel / QueueDock 完全同款的 `conversation.input.dock` 槽注册：
// 由 ConversationRoot 的 sticky composerSeat 统一吸附，几何（宽度/顺序/间距）
// 全部由槽位系统保证，不再依赖任何 DOM 选择器。
//
// 数据来源：本入口只依赖 ctx 服务（sessions / connection / corumEditor），
// 不再依赖 ChatView 的作用域——所以可以脱离 ChatView 独立挂载。
// reviewSource 的 per-binding 缓存留在 apply.ts（WeakMap，ChatView 的
// `review` prop 仍复用同一实例，两侧看到同一份聚合与水位）。

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore, useState } from 'react'
import type {} from '@corum/corum-ui-conversation/client'
import { ReviewCard } from './ReviewCard.tsx'
import type { ReviewSource } from './review-source.ts'
import { NS } from '../locale.ts'
import css from './ReviewCard.module.css'

/** 槽位注入面：按会话解析出的 Review 数据 + 打开 diff 动作。 */
export interface ReviewDockInjected {
  review: ReviewSource
  cwd: string | undefined
  /**
   * 点击文件行：在编辑器打开「本轮改动前 ↔ 当前」的 diff。
   *
   * 由 apply.ts 注入（那里才有 corumEditor 服务与路径换算）；本模块只负责渲染，
   * 不重复实现「重建原文 + 开 diff tab」的编排。
   */
  openDiff: (path: string) => void
}

export type ReviewDockProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'chat'>
  & ReviewDockInjected

/** Review 卡本体：订阅聚合 + 装配两个动作，空集时不渲染（槽位不占高）。 */
export function ReviewDock({ review, cwd, openDiff, t }: ReviewDockProps) {
  const changes = useSyncExternalStore(review.subscribe, review.getSnapshot)
  const [busy, setBusy] = useState(false)
  if (changes.files.length === 0) return null

  /** 所有异步动作共用 busy：撤销是逐文件落盘的，期间禁止并发触发。 */
  const guarded = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await fn()
    } finally {
      setBusy(false)
    }
  }

  const revertAll = () => guarded(() => review.revertAll())
  const revertFile = (path: string) => { void guarded(() => review.revertFile(path)) }

  return (
    <div className={css.reviewCardWrapper}>
      <ReviewCard
        changes={changes}
        cwd={cwd}
        busy={busy}
        onRevertAll={revertAll}
        onKeepAll={() => { review.keepAll() }}
        onOpenDiff={openDiff}
        onKeepFile={path => { review.keepFile(path) }}
        onRevertFile={revertFile}
        t={t as unknown as (key: string, params?: Record<string, string | number>) => string}
      />
    </div>
  )
}

/**
 * 注册 Review 卡到 `conversation.input.dock`。
 *
 * order = -10：设计上 Review 卡排在最上（文件待确认是最需要先看的），
 * Todo 面板 order 0、Queue 面板 order 20 依次在下。
 *
 * `resolve` 由 apply.ts 注入：把「按会话取 ReviewSource / cwd / 打开 diff」
 * 留在 apply 的闭包里（那里已持有 WeakMap 缓存、会话服务与 corumEditor 服务），
 * 本模块只负责「怎么渲染、放哪个槽」，不重复实现数据获取与编排。
 */
export function registerReviewDock(
  ctx: Context,
  resolve: (sessionId: SessionId) => ReviewDockInjected,
): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'review',
    order: -10,
    locale: NS,
    inject: (sessionId: SessionId): ReviewDockInjected => resolve(sessionId),
  }, ReviewDock))
}
