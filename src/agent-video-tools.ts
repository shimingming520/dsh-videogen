/**
 * Agent-facing video tools backed by the same host engine as the panel:
 *  - generate_video         submit / wait / query a generation task
 *  - video_process          FFmpeg processing on URLs / workspace files
 *  - search_video_library   reuse previously generated/saved videos
 *  - manage_storyboard      storyboard templates, project shots, compose
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { randomUUID } from 'node:crypto'
import type { VideoChannel } from './video-engine.ts'
import { VideoGenError } from './video-engine.ts'
import { runGeneration, queryGeneration, parseGenerateRequest } from './generate-core.ts'
import { runProcessAction, ProcessError } from './process-engine.ts'
import { listLibrary, loadProject, saveProject } from './video-store.ts'
import { PROCESS_OUTPUT_DIR } from './video-store.ts'
import { STORYBOARD_TEMPLATES, createProjectFromTemplate, updateShot, shotInputs } from './studio-engine.ts'
import { concatSegments } from './process-engine.ts'
import type { ProcessAction, StoryboardProject } from './protocol.ts'

export interface AgentVideoToolConfig {
  enabled: boolean
  allowAgentVideoGeneration: boolean
  channels: VideoChannel[]
  defaultChannelId: string
  autoSaveToLibrary: boolean
  /** 提示词增强（复用 Agent 默认模型）。 */
  enhance?: (prompt: string, mode: 'text2video' | 'image2video') => Promise<string>
  /** Resolve a workspace-relative path to an absolute one. */
  resolveWorkspacePath: (workspaceId: string, relativePath: string) => Promise<string>
}

function resolveChannel(config: AgentVideoToolConfig, requested: unknown): VideoChannel {
  const entries = config.channels
  if (entries.length === 0) {
    throw new VideoGenError('尚未配置任何视频生成渠道（设置 → 插件 → AI 视频）', 'video-no-channel')
  }
  const wanted = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : ''
  if (wanted === '') {
    const fallback = entries.find(entry => entry.id === config.defaultChannelId)
    if (fallback !== undefined) return fallback
    if (entries.length === 1) return entries[0]!
    const options = entries.map(entry => `"${entry.name}"`).join(', ')
    throw new VideoGenError(`配置了多个视频渠道 — 请先问用户使用哪个渠道，然后带上 channel 参数重试。可选：${options}。`, 'channel-choice-required')
  }
  const hosting = entries.filter(entry => entry.id === wanted || entry.name === wanted)
  if (hosting.length === 0) {
    const available = entries.map(entry => entry.name).join(', ')
    throw new VideoGenError(`渠道 "${wanted}" 未配置。可选：${available}。`, 'channel-not-configured')
  }
  return hosting.find(entry => entry.id === config.defaultChannelId) ?? hosting[0]!
}

function resolveModel(config: AgentVideoToolConfig, channel: VideoChannel, requested: unknown): string | undefined {
  if (requested === undefined || requested === null) return undefined
  const wanted = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : ''
  if (wanted === '') return undefined
  const hosting = channel.models.filter(model => model.alias === wanted || model.id === wanted)
  if (hosting.length > 0) return hosting[0]!.id
  const available = channel.models.map(model => model.alias).join(', ')
  if (channel.models.length === 0) {
    // Model catalog may be empty on custom channels; pass through.
    return wanted
  }
  throw new VideoGenError(`模型 "${wanted}" 未在渠道「${channel.name}」目录中。可用：${available}。`, 'model-not-configured')
}

function textBlock(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/** Detach a result into plain JSON for the tool output contract. */
function jsonify<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function registerAgentVideoTools(ctx: Context, resolve: () => AgentVideoToolConfig): () => void {
  const disposer = ctx.tools.register(defineTool({
    name: 'generate_video',
    description: 'Generate video with the configured video provider. Supports text-to-video and image-to-video across channels (OpenAI-compatible /v1/videos, Kling, MiniMax Hailuo, Volcengine ARK, custom generic). The tool submits the task and by default waits for completion, returning same-origin video URLs for the user to play. If multiple channels are configured, first ask the user which one to use or pass channel explicitly. Pass task_id to query a previously submitted task instead of starting a new one.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The video prompt (scene, subject, motion, style). For image-to-video, describe the desired motion.' },
      mode: { type: 'string', enum: ['text2video', 'image2video'], description: 'Generation mode. Defaults to text2video.' },
      channel: { type: 'string', description: 'Channel name or id; defaults to the default channel.' },
      model: { type: 'string', description: 'One of the configured models of the channel.' },
      image: { type: 'string', description: 'For image2video: http(s) URL, data: URL, or ws:<workspaceId>/<path> reference of the source image.' },
      negative_prompt: { type: 'string', description: 'Optional negative prompt (where supported).' },
      aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'Optional aspect ratio (provider-dependent).' },
      duration: { type: 'number', description: 'Requested duration in seconds (provider-dependent; e.g. Kling 5/10, OpenAI-compatible seconds).' },
      resolution: { type: 'string', description: 'Optional upstream resolution/size, e.g. "1024x1792" (provider-dependent).' },
      seed: { type: 'integer', description: 'Optional random seed where supported.' },
      enhance_prompt: { type: 'boolean', description: 'Enhance the prompt with the agent default model before generating (no extra key). Best-effort: on failure the original prompt is used.' },
      task_id: { type: 'string', description: 'When present, query this previously submitted task instead of starting a new one.' },
      wait: { type: 'boolean', description: 'Wait for completion (default true). Pass false to submit and return the task id immediately.' },
      wait_seconds: { type: 'number', description: 'Max wait seconds when waiting (default 240, cap 900). If the task is still running afterwards, the returned task_id can be used with a later call.' },
      save_to_library: { type: 'boolean', description: 'Save the generated video into the local resource library after success. Also enabled globally by the "auto save to library" setting.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => textBlock(value),
    },
    timeoutMs: 660_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>) {
      const config = resolve()
      if (!config.enabled) throw new VideoGenError('dsh-videogen 插件已禁用', 'video-disabled')
      const raw: Record<string, unknown> = {
        mode: args.mode === 'image2video' ? 'image2video' : 'text2video',
        channelId: typeof args.channel === 'string' ? args.channel : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : '',
        model: typeof args.model === 'string' ? args.model : undefined,
        image: typeof args.image === 'string' ? args.image : undefined,
        negativePrompt: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
        aspectRatio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : undefined,
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        resolution: typeof args.resolution === 'string' ? args.resolution : undefined,
        seed: typeof args.seed === 'number' ? args.seed : undefined,
        enhancePrompt: args.enhance_prompt === true,
        saveToLibrary: args.save_to_library === true,
        wait: args.wait !== false,
        waitSeconds: typeof args.wait_seconds === 'number' ? args.wait_seconds : undefined,
      }
      const request = parseGenerateRequest(raw)
      if (request === undefined) throw new VideoGenError('缺少 prompt', 'bad-prompt')
      const channel = resolveChannel(config, raw.channelId)
      if (raw.model !== undefined) request.model = resolveModel(config, channel, raw.model)
      if (request.image !== undefined) {
        request.image = await resolveReference(request.image, config.resolveWorkspacePath)
      }
      if (request.enhancePrompt === true && config.enhance !== undefined) {
        request.prompt = await config.enhance(request.prompt, request.mode)
      }
      const taskId = typeof args.task_id === 'string' && args.task_id.trim() !== '' ? args.task_id.trim() : undefined
      if (taskId !== undefined) {
        return jsonify(await queryGeneration(channel, taskId, {}))
      }
      const result = await runGeneration({
        channel,
        request,
        wait: request.wait !== false,
        waitSeconds: request.waitSeconds,
        autoSave: () => config.autoSaveToLibrary || request.saveToLibrary === true,
      })
      return jsonify(result)
    },
  }))

  const processDisposer = ctx.tools.register(defineTool({
    name: 'video_process',
    description: 'Process a video with FFmpeg: probe metadata (info), extract frames (frames), convert to GIF (gif), compress an image (compress), or concatenate segments with optional crossfade and background audio (concat). Inputs may be http(s) URLs (e.g. generated video URLs), ws:<workspaceId>/<path> references or absolute paths. Outputs are returned as same-origin URLs.',
    parameters: {
      action: { type: 'string', required: true, enum: ['info', 'frames', 'gif', 'compress', 'concat'], description: 'info: probe duration/resolution/codecs. frames: extract evenly spaced JPEG frames or one at a timestamp. gif: convert a clip to an animated GIF. compress: recompress an image to JPEG at a target width. concat: join several videos in order.' },
      input: { type: 'string', description: 'Primary input for info/frames/gif/compress (URL, ws: reference or absolute path).' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'Comma-order inputs for concat (URLs / ws: references).' },
      count: { type: 'integer', description: 'frames: number of frames to extract evenly (1-20, default 1).' },
      at: { type: 'number', description: 'frames: grab one frame at this second instead of N frames.' },
      width: { type: 'integer', description: 'Output width keeping aspect (frames/compress/gif/concat).' },
      quality: { type: 'integer', description: 'JPEG quality 1-31, lower is better (frames/compress).' },
      start: { type: 'number', description: 'gif: start time in seconds (default 0).' },
      duration: { type: 'number', description: 'gif: clip duration in seconds; concat: max per-segment trim.' },
      fps: { type: 'integer', description: 'gif output fps (default 10); concat normalization fps (default 30).' },
      transition: { type: 'number', description: 'concat: crossfade duration in seconds (0 = hard cut).' },
      audio_url: { type: 'string', description: 'concat: background audio URL mixed into the final video.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => textBlock(value),
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>) {
      const action = args.action
      if (action !== 'info' && action !== 'frames' && action !== 'gif' && action !== 'compress' && action !== 'concat') {
        throw new ProcessError(`未知 action: ${String(action)}`, 'bad-action')
      }
      const resolveMaybe = async (value: unknown): Promise<string | undefined> => {
        if (typeof value !== 'string' || value.trim() === '') return undefined
        return resolveReference(value, resolve().resolveWorkspacePath)
      }
      const input = await resolveMaybe(args.input)
      const inputs = Array.isArray(args.inputs)
        ? (await Promise.all((args.inputs as unknown[]).filter((item): item is string => typeof item === 'string').map(item => resolveReference(item, resolve().resolveWorkspacePath))))
        : undefined
      const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
      const result = await runProcessAction({
        action: action as ProcessAction,
        input,
        inputs,
        count: num(args.count),
        at: num(args.at),
        width: num(args.width),
        quality: num(args.quality),
        start: num(args.start),
        duration: num(args.duration),
        fps: num(args.fps),
        transition: num(args.transition),
        audioUrl: typeof args.audio_url === 'string' && args.audio_url.trim() !== '' ? args.audio_url.trim() : undefined,
        outDir: PROCESS_OUTPUT_DIR,
      })
      if (result.frames !== undefined) {
        result.frames = result.frames.map(frame => ({ ...frame, url: `/api/dsh-videogen/assets/output/${encodeURIComponent(frame.file)}` }))
      }
      if (result.output !== undefined) {
        result.output = { ...result.output, url: `/api/dsh-videogen/assets/output/${encodeURIComponent(result.output.file)}` }
      }
      return jsonify(result)
    },
  }))

  const searchDisposer = ctx.tools.register(defineTool({
    name: 'search_video_library',
    description: 'Search the local video resource library (generated videos, frames, gifs and storyboards) and reuse an existing video instead of generating a new one.',
    parameters: {
      keyword: { type: 'string', description: 'Free-text search over name, tags, category, prompt and model.' },
      type: { type: 'string', enum: ['video', 'image', 'gif', 'storyboard'], description: 'Filter by resource type.' },
      category: { type: 'string', description: 'Filter by category.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => textBlock(value),
    },
    timeoutMs: 30_000,
    async execute(args: Record<string, unknown>) {
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : ''
      const type = typeof args.type === 'string' ? args.type : undefined
      const category = typeof args.category === 'string' ? args.category : undefined
      const entries = (await listLibrary()).filter(entry => {
        if (type !== undefined && entry.type !== type) return false
        if (category !== undefined && entry.category !== category) return false
        if (keyword !== '') {
          const haystack = `${entry.name} ${(entry.tags ?? []).join(' ')} ${entry.category ?? ''} ${entry.provenance.prompt ?? ''} ${entry.provenance.model ?? ''}`.toLowerCase()
          if (!haystack.includes(keyword)) return false
        }
        return true
      }).slice(0, 50)
      return jsonify({ entries })
    },
  }))

  const storyboardDisposer = ctx.tools.register(defineTool({
    name: 'manage_storyboard',
    description: 'Manage storyboard video projects: list_templates (bundled cinematic shot templates), new (create a project from a template + variables), get (read a project and its shots), update_shot (edit a shot prompt/name/duration/image), attach_video (attach a generated video URL from generate_video to a shot), compose (concatenate ready shots into one video with FFmpeg) and generate_all (generate every pending shot through the configured channel, returning task ids for ones still running).',
    parameters: {
      action: { type: 'string', required: true, enum: ['list_templates', 'new', 'get', 'update_shot', 'attach_video', 'compose', 'generate_all'], description: 'Action to perform.' },
      project_id: { type: 'string', description: 'Project id (required for get/update_shot/attach_video/compose/generate_all).' },
      template_id: { type: 'string', description: 'new: storyboard template id (from list_templates).' },
      name: { type: 'string', description: 'new: project name. update_shot: new shot name.' },
      vars: { type: 'object', additionalProperties: true, description: 'new: template variables (e.g. {"product":"NEON X1"}).' },
      shot_id: { type: 'string', description: 'update_shot/attach_video: shot id.' },
      prompt: { type: 'string', description: 'update_shot: new shot prompt text.' },
      image: { type: 'string', description: 'update_shot: new reference image for this shot (URL or ws: reference).' },
      video_url: { type: 'string', description: 'attach_video: the generated video URL to attach to the shot.' },
      generate: { type: 'boolean', description: 'generate_all: also generate shots (default true).' },
      channel: { type: 'string', description: 'generate_all: channel to use.' },
      model: { type: 'string', description: 'generate_all: model to use.' },
      transition: { type: 'number', description: 'compose: crossfade seconds (default keeps shot transitions).' },
      audio_url: { type: 'string', description: 'compose: background music URL.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => textBlock(value),
    },
    timeoutMs: 660_000,
    async execute(args: Record<string, unknown>) {
      const action = args.action
      if (action === 'list_templates') {
        return jsonify({ templates: STORYBOARD_TEMPLATES.map(template => ({ id: template.id, name: template.name, description: template.description, aspectRatio: template.aspectRatio, duration: template.duration, variables: template.variables, shots: template.shots.map(shot => ({ id: shot.id, name: shot.name, duration: shot.duration, transition: shot.transition, prompt: shot.prompt })) })) })
      }
      if (action === 'new') {
        const templateId = typeof args.template_id === 'string' ? args.template_id : ''
        if (templateId === '') throw new Error('new 需要 template_id')
        const vars: Record<string, string> = {}
        if (typeof args.vars === 'object' && args.vars !== null) {
          for (const [key, value] of Object.entries(args.vars as Record<string, unknown>)) {
            if (typeof value === 'string') vars[key] = value
          }
        }
        const project = createProjectFromTemplate(templateId, typeof args.name === 'string' && args.name !== '' ? args.name : templateId, vars)
        await saveProject(project)
        return jsonify({ project })
      }
      if (action === 'get') {
        const id = String(args.project_id ?? '')
        const project = await loadProject(id)
        if (project === undefined) throw new Error(`项目不存在: ${id}`)
        return jsonify({ project })
      }
      if (action === 'update_shot' || action === 'attach_video') {
        const id = String(args.project_id ?? '')
        const shotId = String(args.shot_id ?? '')
        let project = await loadProject(id)
        if (project === undefined) throw new Error(`项目不存在: ${id}`)
        if (action === 'attach_video') {
          const videoUrl = String(args.video_url ?? '')
          if (videoUrl === '') throw new Error('attach_video 需要 video_url')
          const shots = project.shots.map(shot => shot.id === shotId ? { ...shot, videoUrl, status: 'ready' as const, error: undefined } : shot)
          project = { ...project, shots, updatedAt: Date.now() }
        } else {
          const patch: Record<string, unknown> = {}
          if (typeof args.prompt === 'string') patch.prompt = args.prompt
          if (typeof args.name === 'string') patch.name = args.name
          if (typeof args.image === 'string') patch.imageUrl = await resolveReference(args.image, resolve().resolveWorkspacePath)
          project = updateShot(project, shotId, patch as never)
        }
        await saveProject(project)
        return jsonify({ project })
      }
      if (action === 'compose') {
        const id = String(args.project_id ?? '')
        const project = await loadProject(id)
        if (project === undefined) throw new Error(`项目不存在: ${id}`)
        const segments = shotInputs(project)
        if (segments.length === 0) throw new Error('没有已经准备好的镜头（先 generate_all 或 attach_video）')
        const outFile = `studio_${project.id.slice(0, 8)}_${randomUUID().slice(0, 6)}.mp4`
        const outPath = `${PROCESS_OUTPUT_DIR}/${outFile}`
        const [w, h] = project.aspectRatio.split(':').map(Number)
        await concatSegments(segments, {
          outPath,
          width: w !== undefined && h !== undefined && w / h >= 1 ? 1280 : 720,
          height: w !== undefined && h !== undefined && w / h >= 1 ? 720 : 1280,
          transition: typeof args.transition === 'number' ? args.transition : undefined,
          audioUrl: typeof args.audio_url === 'string' && args.audio_url.trim() !== '' ? args.audio_url.trim() : undefined,
        })
        return jsonify({ ok: true, output: { file: outFile, url: `/api/dsh-videogen/assets/output/${encodeURIComponent(outFile)}` } })
      }
      if (action === 'generate_all') {
        const id = String(args.project_id ?? '')
        const project = await loadProject(id)
        if (project === undefined) throw new Error(`项目不存在: ${id}`)
        const config = resolve()
        const channel = resolveChannel(config, args.channel)
        const model = resolveModel(config, channel, args.model)
        const results: Array<{ shotId: string; name: string; status: string; taskId?: string; url?: string; error?: string }> = []
        for (const shot of project.shots) {
          if (shot.status === 'ready') {
            results.push({ shotId: shot.id, name: shot.name, status: 'ready' })
            continue
          }
          try {
            const result = await runGeneration({
              channel,
              request: {
                mode: shot.imageUrl !== undefined && shot.imageUrl !== '' ? 'image2video' : 'text2video',
                prompt: shot.prompt,
                ...(shot.imageUrl !== undefined && shot.imageUrl !== '' ? { image: shot.imageUrl } : {}),
                ...(model !== undefined ? { model } : {}),
                aspectRatio: project.aspectRatio,
                duration: shot.duration,
              },
              wait: true,
              waitSeconds: 120,
              autoSave: () => config.autoSaveToLibrary,
            })
            if (result.status === 'completed' && result.videos.length > 0) {
              const shots = project.shots.map(item => item.id === shot.id ? { ...item, videoUrl: result.videos[0]!.url, status: 'ready' as const, error: undefined } : item)
              await saveProject({ ...project, shots, updatedAt: Date.now() })
              results.push({ shotId: shot.id, name: shot.name, status: 'ready', url: result.videos[0]!.url })
            } else {
              const shots = project.shots.map(item => item.id === shot.id ? { ...item, status: 'failed' as const, params: { ...item.params, pendingTaskId: result.taskId }, error: result.error ?? '任务仍在处理中' } : item)
              await saveProject({ ...project, shots, updatedAt: Date.now() })
              results.push({ shotId: shot.id, name: shot.name, status: 'pending', taskId: result.taskId, error: result.error ?? '任务仍在处理中' })
            }
          } catch (error) {
            results.push({ shotId: shot.id, name: shot.name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
          }
        }
        return jsonify({ results })
      }
      throw new Error(`未知 action: ${String(action)}`)
    },
  }))

  return () => {
    disposer()
    processDisposer()
    searchDisposer()
    storyboardDisposer()
  }
}

/** Resolve a ws: workspace reference to an absolute path before use. */
async function resolveReference(value: string, resolveWorkspacePath: (workspaceId: string, relativePath: string) => Promise<string>): Promise<string> {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('ws:')) {
    const rest = trimmed.slice(3)
    const slash = rest.indexOf('/')
    if (slash <= 0) throw new Error('ws: 前缀格式应为 ws:<workspaceId>/<relativePath>')
    return resolveWorkspacePath(rest.slice(0, slash), rest.slice(slash + 1))
  }
  return trimmed
}
