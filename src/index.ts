/**
 * dsh-videogen — host half.
 *
 * Mounts the plugin settings section (multi-provider video channels), the
 * /api/dsh-videogen route family (settings bridge, presets, generation proxy,
 * FFmpeg processing, storyboard studio, asset/history/library serving), and
 * the Agent video tools. The browser half (./client) renders the sidebar
 * entry and the AI 视频 panel.
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as resolvePath } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { VIDE0GEN_SETTINGS_NAMESPACE, type CustomChannelSpec, type LlmModelOption, type ModelMapping, type VideoMode } from './protocol.ts'
import type { VideoChannel } from './video-engine.ts'
import { VideoGenError } from './video-engine.ts'
import { makeRoutes, type ChannelsView, type SettingsSeam } from './routes.ts'
import { enhancePromptText } from './prompt-enhance.ts'
import { videoPresetById } from './video-presets.ts'
import { registerAgentVideoTools, type AgentVideoToolConfig } from './agent-video-tools.ts'

/** Stable cordis plugin name. */
export const name = 'videogen'

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt']

/** The settings namespace of this plugin. */
export const VideoGenSettingsNamespace = VIDE0GEN_SETTINGS_NAMESPACE

export interface Config {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentVideoGeneration?: boolean
  channels?: Array<{
    id: string
    preset: string
    name: string
    apiUrl: string
    authMode?: string
    customJson?: string
    models: Array<{ alias: string; id: string }>
  }>
  channelSecrets?: Record<string, string>
  defaultChannelId?: string
  defaultModel?: string
  autoSaveToLibrary?: boolean
  /** 提示词增强模型，格式 "provider|model"；空串表示跟随 Agent 默认模型。 */
  enhanceModel?: string
}

const DEFAULT_ENABLED = true
const DEFAULT_ANNOUNCE = true
const DEFAULT_ALLOW_AGENT_VIDEO = true

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  allowAgentVideoGeneration: z.boolean().default(true),
  channels: z.array(z.object({
    id: z.string(),
    preset: z.string().default(''),
    name: z.string().default(''),
    apiUrl: z.string().default(''),
    authMode: z.string().default('bearer'),
    customJson: z.string().default(''),
    models: z.array(z.object({
      alias: z.string(),
      id: z.string(),
    })).default([]),
  })).default([]),
  channelSecrets: z.dict(z.string().role('secret')).default({}),
  defaultChannelId: z.string().default(''),
  defaultModel: z.string().default(''),
  autoSaveToLibrary: z.boolean().default(false),
  enhanceModel: z.string().default(''),
})

const SECTION_ORDER = 161

export const VIDEOGEN_GUIDANCE = '本机已安装 dsh-videogen 插件（DSH AI 视频）：侧边栏「AI 视频」入口。能力：通过「渠道」对接多个视频生成厂商（OpenAI 兼容 /v1/videos、可灵 Kling、海螺 MiniMax、即梦/火山 ARK、自定义通用异步渠道），支持文生视频与图生视频，以及 FFmpeg 视频处理（探测元数据、抽帧、视频转 GIF、图片压缩、多段合成）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发。Agent 可直接调用 `generate_video` 提交文生/图生视频任务（mode=text2video/image2video，可传 channel/model/image/negative_prompt/aspect_ratio/duration），默认等待完成并返回同源视频 URL；传 task_id 可查询已提交任务；`video_process` 对 URL/工作区文件执行 info/frames/gif/compress/concat；`manage_storyboard` 管理分镜项目（list_templates/new/get/update_shot/attach_video/compose/generate_all）；`search_video_library` 检索本地资源库。限制：生成消耗上游 API 额度；视频内容由上游模型生成；模型只能使用用户在各渠道配置目录中的模型。用户提到「视频 / 短视频 / 视频生成 / 分镜 / TTV / I2V / AI 视频」时即指本插件，请据此协作。'

function guidanceFor(channels: VideoChannel[], defaultChannelId: string): string {
  if (channels.length === 0) {
    return `${VIDEOGEN_GUIDANCE} 尚未配置任何渠道：请先在「设置 → 插件 → AI 视频」添加渠道并填写 API 地址与密钥。`
  }
  const table = channels.map(channel => {
    const aliases = channel.models.map(model => model.alias).join('、')
    const mark = channel.id === defaultChannelId ? '（默认渠道）' : ''
    const key = channel.apiKey === '' ? '（未填密钥）' : ''
    const models = channel.models.length === 0 ? '未配置模型' : `可用模型：${aliases}`
    return `渠道「${channel.name}」${mark}[${channel.apiUrl}] ${models}${key}`
  }).join('；')
  return `${VIDEOGEN_GUIDANCE} 当前渠道与模型：${table}。`
}

/**
 * 把随包分发的技能（skills/<id>/SKILL.md，含 frontmatter）同步到 DSH 用户技能根
 * `~/.dsh/skills/<id>/SKILL.md`。仅创建缺失文件，绝不覆盖用户已有内容。
 */
function syncBundledSkills(): void {
  try {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    const sourceRoot = join(packageRoot, 'skills')
    if (existsSync(sourceRoot) !== true) return
    const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
    const targetRoot = join(dshHome, 'skills')
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() !== true) continue
      const sourceFile = join(sourceRoot, entry.name, 'SKILL.md')
      if (existsSync(sourceFile) !== true) continue
      const targetDir = join(targetRoot, entry.name)
      const targetFile = join(targetDir, 'SKILL.md')
      if (existsSync(targetFile)) continue
      mkdirSync(targetDir, { recursive: true })
      copyFileSync(sourceFile, targetFile)
    }
  } catch {
    // 技能同步为最佳努力：失败不阻断插件启动。
  }
}

function normalizeChannels(value: unknown): Array<{ id: string; preset: string; name: string; apiUrl: string; authMode: string; customJson: string; models: ModelMapping[] }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ id: string; preset: string; name: string; apiUrl: string; authMode: string; customJson: string; models: ModelMapping[] }> = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') continue
    const models: ModelMapping[] = []
    if (Array.isArray(raw.models)) {
      for (const entry of raw.models) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Record<string, unknown>
        const alias = typeof record.alias === 'string' ? record.alias.trim() : ''
        const upstream = typeof record.id === 'string' ? record.id.trim() : ''
        if (alias === '') continue
        models.push({ alias, id: upstream === '' ? alias : upstream })
      }
    }
    out.push({
      id,
      preset: typeof raw.preset === 'string' ? raw.preset : '',
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl.trim() : '',
      authMode: typeof raw.authMode === 'string' ? raw.authMode : 'bearer',
      customJson: typeof raw.customJson === 'string' ? raw.customJson : '',
      models,
    })
  }
  return out
}

function parseCustomSpec(json: string): CustomChannelSpec | undefined {
  if (json.trim() === '') return undefined
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    if (typeof parsed.submitUrl !== 'string' || parsed.submitUrl.trim() === '') return undefined
    const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
    const spec: CustomChannelSpec = { submitUrl: parsed.submitUrl.trim() }
    const bodyTemplate = str(parsed.bodyTemplate)
    if (bodyTemplate !== undefined) spec.bodyTemplate = bodyTemplate
    const taskIdPath = str(parsed.taskIdPath)
    if (taskIdPath !== undefined) spec.taskIdPath = taskIdPath
    const pollUrlTemplate = str(parsed.pollUrlTemplate)
    if (pollUrlTemplate !== undefined) spec.pollUrlTemplate = pollUrlTemplate
    const pollMethod = str(parsed.pollMethod)
    if (pollMethod !== undefined) spec.pollMethod = pollMethod
    const statusPath = str(parsed.statusPath)
    if (statusPath !== undefined) spec.statusPath = statusPath
    const doneValues = str(parsed.doneValues)
    if (doneValues !== undefined) spec.doneValues = doneValues
    const failValues = str(parsed.failValues)
    if (failValues !== undefined) spec.failValues = failValues
    const resultUrlPath = str(parsed.resultUrlPath)
    if (resultUrlPath !== undefined) spec.resultUrlPath = resultUrlPath
    const apiKeyHeader = str(parsed.apiKeyHeader)
    if (apiKeyHeader !== undefined) spec.apiKeyHeader = apiKeyHeader
    const apiKeyScheme = str(parsed.apiKeyScheme)
    if (apiKeyScheme !== undefined) spec.apiKeyScheme = apiKeyScheme
    return spec
  } catch {
    return undefined
  }
}

export interface EffectiveConfig {
  enabled: boolean
  announceToAgent: boolean
  allowAgentVideoGeneration: boolean
  channels: VideoChannel[]
  defaultChannelId: string
  defaultModel: string
  autoSaveToLibrary: boolean
  enhanceModel: string
}

export function apply(ctx: Context, config?: Config): void {
  syncBundledSkills()
  let current: () => Config = () => config ?? {}

  const resolve = (): EffectiveConfig => {
    const value = current() ?? {}
    const channels = normalizeChannels(value.channels)
    const secrets: Record<string, string> = { ...(value.channelSecrets ?? {}) }
    const named = channels.map(channel => ({
      ...channel,
      name: channel.name === '' ? (videoPresetById(channel.preset)?.name ?? '未命名渠道') : channel.name,
    }))
    const defaultChannelId = typeof value.defaultChannelId === 'string' && named.some(channel => channel.id === value.defaultChannelId)
      ? value.defaultChannelId
      : named[0]?.id ?? ''
    return {
      enabled: value.enabled ?? DEFAULT_ENABLED,
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      allowAgentVideoGeneration: value.allowAgentVideoGeneration ?? DEFAULT_ALLOW_AGENT_VIDEO,
      channels: named.map(channel => {
        const resolved: VideoChannel = {
          id: channel.id,
          preset: channel.preset,
          name: channel.name,
          apiUrl: channel.apiUrl,
          apiKey: typeof secrets[channel.id] === 'string' ? secrets[channel.id] : '',
          models: channel.models,
          authMode: channel.authMode === 'jwt' ? 'jwt' : 'bearer',
          custom: parseCustomSpec(channel.customJson),
        }
        if (resolved.preset === 'ark') {
          // ARK ships a bundled template; user JSON overrides it when provided.
          resolved.custom = parseCustomSpec(channel.customJson) ?? videoPresetById('ark')?.custom
        } else if (resolved.preset !== '' && resolved.preset !== 'custom') {
          // Other built-in presets may override their protocol via JSON when filled.
          resolved.custom = parseCustomSpec(channel.customJson) ?? resolved.custom
        }
        return resolved
      }),
      defaultChannelId,
      defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel.trim() : '',
      enhanceModel: typeof value.enhanceModel === 'string' ? value.enhanceModel.trim() : '',
      autoSaveToLibrary: value.autoSaveToLibrary === true,
    }
  }

  // 提示词增强：优先用设置的增强模型（enhanceModel），否则复用 Agent 默认模型。
  const enhance = async (prompt: string, mode: VideoMode): Promise<string> => {
    const seam = ctx.get('settings') as unknown as SettingsSeam
    if (seam?.describe === undefined) throw new VideoGenError('设置服务不可用，无法增强提示词', 'settings-unavailable')
    return enhancePromptText({ settings: seam, llm: () => ctx.get('llm') }, prompt, mode, enhanceSelectionOf(resolve()))
  }

  const enhanceSelectionOf = (config: EffectiveConfig): { provider: string; model: string } | undefined => {
    const raw = config.enhanceModel ?? ''
    const sep = raw.indexOf('|')
    if (sep <= 0 || sep >= raw.length - 1) return undefined
    const provider = raw.slice(0, sep).trim()
    const model = raw.slice(sep + 1).trim()
    return provider !== '' && model !== '' ? { provider, model } : undefined
  }

  const llmModelOptions = async (): Promise<LlmModelOption[]> => {
    const llm = ctx.get('llm') as {
      listProviders?: () => Array<{ id?: string; name?: string }>
      listConfigurableProviders?: () => Array<{ provider?: string; displayName?: string }>
      listModels?: (provider: string) => Promise<Array<{ id?: string; name?: string }>>
    } | undefined
    if (llm === undefined || llm.listProviders === undefined || llm.listModels === undefined) return []
    const options: LlmModelOption[] = []
    const directory = new Map<string, string>()
    if (llm.listConfigurableProviders !== undefined) {
      for (const entry of llm.listConfigurableProviders() ?? []) {
        if (typeof entry.provider === 'string' && entry.provider !== '' && typeof entry.displayName === 'string') {
          directory.set(entry.provider, entry.displayName)
        }
      }
    }
    for (const info of llm.listProviders() ?? []) {
      const provider = typeof info.id === 'string' ? info.id : ''
      if (provider === '') continue
      let models: Array<{ id?: string; name?: string }> = []
      try { models = (await llm.listModels(provider)) ?? [] } catch { models = [] }
      for (const model of models) {
        const id = typeof model.id === 'string' ? model.id.trim() : ''
        if (id === '') continue
        const name = typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : id
        options.push({ provider, providerName: directory.get(provider) ?? provider, id, name })
      }
    }
    return options
  }

  const channelsView = (): ChannelsView => {
    const value = resolve()
    return { channels: value.channels, defaultChannelId: value.defaultChannelId }
  }

  const resolveWorkspacePath = async (workspaceId: string, relativePath: string): Promise<string> => {
    const registry = ctx.get('workspaceRegistry') as {
      list?: () => Array<{ id?: string; path?: string }>
    } | undefined
    const workspace = registry?.list?.().find(entry => entry.id === workspaceId)
    if (workspace === undefined || typeof workspace.path !== 'string') {
      throw new VideoGenError(`找不到工作区: ${workspaceId}`, 'workspace-unknown')
    }
    return resolvePath(workspace.path, relativePath)
  }

  ctx.inject(['settings', 'webServer'], (sctx) => {
    const seam = sctx.get('settings') as unknown as SettingsSeam
    sctx.effect(() => {
      const routes = makeRoutes({
        settings: seam,
        resolveChannels: channelsView,
        autoSave: () => resolve().autoSaveToLibrary,
        enhance,
        llmModelOptions,
        resolveWorkspacePath,
      })
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-videogen: routes')
  })

  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => registerAgentVideoTools(tctx, (): AgentVideoToolConfig => {
      const value = resolve()
      return {
        enabled: value.enabled,
        allowAgentVideoGeneration: value.allowAgentVideoGeneration,
        channels: value.channels,
        defaultChannelId: value.defaultChannelId,
        autoSaveToLibrary: value.autoSaveToLibrary,
        enhance,
        resolveWorkspacePath,
      }
    }), 'dsh-videogen: agent video tools')
  })

  let disposeSection: (() => void) | undefined
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:dsh-videogen',
      order: SECTION_ORDER,
      text: guidanceFor(value.channels, value.defaultChannelId),
    })
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, VideoGenSettingsNamespace, Config, config ?? {}, {
      setSource: (source) => {
        current = source
        sync()
      },
      onChange: sync,
    })
  })

  sync()
}
