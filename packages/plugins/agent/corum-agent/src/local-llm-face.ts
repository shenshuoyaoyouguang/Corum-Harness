/**
 * localLlm 服务的窄能力接口（跨 bundle 类型面收敛，见 skills/corum-dev-conventions/SKILL.md 规则 3）。
 * corum-agent 只依赖这个 face，不耦合 @corum/corum-ollama 的实现包。
 * @module @corum/corum-agent/local-llm-face
 */

/** 一个已拉取的本地模型（与 @corum/corum-ollama 的 PulledModel 同形的只读子集）。 */
export interface LocalPulledModel {
  /** 模型名（如 'qwen3.5:2b'）。 */
  name: string
  /** 磁盘占用（人类可读）。 */
  size?: string
  /** 是否已激活（加载到内存）。 */
  active?: boolean
  /** 激活后占用的 VRAM（字节）。 */
  vramBytes?: number
  /** 参数量（如 '8.0B'）。 */
  paramSize?: string
}

/** 本地引擎探测结果（与 @corum/corum-ollama 对齐的只读投影）。 */
export interface LocalEngineStatus {
  installed: boolean
  running: boolean
  totalMemGb: number
  meetsMinMem: boolean
  modelPulled: boolean
  /** 已拉取的模型（含激活态）。⚠️ 是对象数组，不是名字数组（face 曾写错，2026-09-09 修）。 */
  models: LocalPulledModel[]
  version?: string
}

/** 本地 chat 调用入参。 */
export interface LocalChatArgs {
  model: string
  prompt: string
  temperature?: number
  numCtx?: number
  numPredict?: number
}

/** 本地 chat 返回。 */
export interface LocalChatResult {
  text: string
  durationMs: number
}

/** localLlm 服务能力接口（corum-agent 消费子集）。 */
export interface LocalLlmFace {
  status(): Promise<LocalEngineStatus>
  ensureServer(): Promise<{ ok: boolean; error?: string }>
  chat(args: LocalChatArgs): Promise<LocalChatResult>
}

/**
 * Context 面：`localLlm` 是**可选**服务（只有 @corum/corum-ollama 挂载时才存在）。
 * 这里以窄能力接口（LocalLlmFace）声明，不 import 实现包——见 skills/corum-dev-conventions/SKILL.md 规则 3。
 * 调用方一律 `ctx.get('localLlm')`（不用 inject：缺席时插件仍要能激活）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本地 LLM 引擎（Ollama）服务；未挂载 corum-ollama 时 undefined。 */
    localLlm?: LocalLlmFace
  }
}
