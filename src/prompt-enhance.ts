/**
 * 提示词增强：复用 Agent 当前默认模型（设置「模型」里的 provider/model，
 * 即 agent-default-model 命名空间），宿主端发起一次 LLM 调用把用户 prompt
 * 扩展成更适合视频生成的描述。不新增 API key 配置。
 *
 * 面板「✨ 增强提示词」与 generate_video 工具的 enhance_prompt 都走这里。
 */

import type { VideoMode } from './protocol.ts'
import { VideoGenError } from './video-engine.ts'

function instructionsFor(mode: VideoMode): string {
  const common = [
    '你是一个视频提示词增强助手。用户给出一个粗略的视频生成需求，',
    '请将其扩写为一段可直接提交给视频生成模型的中文或英文描述。',
    '只输出增强后的描述本身，不要输出任何解释、前后缀、引号或代码块。',
    '保持用户原始意图，不要改变其核心内容；为最终生成的视频服务。',
    '描述控制在 100-300 字左右。',
  ].join('')
  const perMode: Record<VideoMode, string> = {
    text2video: '这是文生视频任务：扩写场景、主体、动作叙事、镜头运动（推拉摇移/环绕/特写）、光影氛围、风格质感、色彩基调，使用视频生成模型熟悉的电影语言，避免冗长动作描述，保留可拍的单一镜头。',
    image2video: '这是图生视频任务：在保留参考图主体的前提下，扩写运动/动画方向（主体运动、镜头运动、环境变化、光影变化），描述清晰可执行的动态意图，避免改变参考图构图与主体。',
  }
  return common + perMode[mode]
}

export interface PromptEnhanceDeps {
  /** DSH 设置 seam（读 agent-default-model）。 */
  settings: { describe(options?: { redactSecrets?: boolean }): Array<{ ns: unknown; value?: unknown }> }
  /** 宿主 LLM 运行时访问器（延迟读取，调用时才获取）。 */
  llm?: () => unknown
}

/** 设置中显式选择的增强模型（provider + model）。 */
export interface EnhanceModelSelection {
  provider: string
  model: string
}

/** 读取 Agent 默认模型并调用 LLM 增强，返回增强后的文本。 */
export async function enhancePromptText(
  deps: PromptEnhanceDeps,
  prompt: string,
  mode: VideoMode,
  override?: EnhanceModelSelection,
): Promise<string> {
  const text = prompt.trim()
  if (text === '') throw new VideoGenError('提示词为空，无法增强', 'enhance-empty-prompt')
  const selected = override !== undefined && override.provider.trim() !== '' && override.model.trim() !== ''
    ? { provider: override.provider.trim(), model: override.model.trim() }
    : undefined
  const descriptor = selected === undefined
    ? (deps.settings.describe({ redactSecrets: true }) ?? []).find(candidate => String(candidate.ns) === 'agent-default-model')
    : undefined
  const value = selected ?? ((descriptor?.value ?? {}) as { provider?: unknown; model?: unknown })
  const provider = typeof value.provider === 'string' && value.provider.trim() !== '' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' && value.model.trim() !== '' ? value.model.trim() : ''
  if (provider === '' || model === '') {
    throw new VideoGenError('未找到 Agent 默认模型（agent-default-model）：请先在「设置 → 模型」中配置默认模型', 'no-default-model')
  }
  const runtime = deps.llm?.() as { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined
  if (runtime === undefined || runtime.stream === undefined) {
    throw new VideoGenError('宿主 LLM 服务不可用（ctx.llm 未注册）', 'llm-unavailable')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), 30_000)
  timer.unref?.()
  let output = ''
  let terminalFailure = ''
  try {
    for await (const chunk of runtime.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      system: instructionsFor(mode),
      temperature: 0.7,
      maxTokens: 800,
      signal: controller.signal,
    })) {
      const record = chunk as { type?: string; text?: string; block?: { type?: string; text?: string }; reason?: { kind?: string; failure?: { message?: string; code?: string } } }
      if (record.type === 'text-delta' && typeof record.text === 'string') {
        output += record.text
      } else if (record.type === 'block-end' && record.block !== undefined
        && record.block.type === 'text' && typeof record.block.text === 'string') {
        output += record.block.text
      } else if (record.type === 'finish' && record.reason !== undefined
        && record.reason.kind !== 'stop' && record.reason.kind !== undefined && terminalFailure === '') {
        const failure = record.reason.failure
        terminalFailure = typeof failure?.message === 'string' && failure.message.trim() !== ''
          ? `${failure.message}${typeof failure.code === 'string' ? `（${failure.code}）` : ''}`
          : `stream ${record.reason.kind}`
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const result = stripFences(output.trim())
  if (result === '') {
    if (terminalFailure !== '') {
      throw new VideoGenError(`增强失败：LLM 调用出错（${terminalFailure}）。请检查「设置 → 模型」的默认模型是否可用`, 'enhance-llm-error')
    }
    throw new VideoGenError('模型未返回增强内容：请检查「设置 → 模型」的默认模型是否可用（或稍后重试）', 'enhance-empty-result')
  }
  return result
}

/** 去掉模型可能包裹的 ``` 代码围栏。 */
function stripFences(value: string): string {
  if (value === '') return value
  return value.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
}
