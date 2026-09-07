/**
 * The /api/dsh-videogen route family:
 *  - a loopback-only settings bridge for the plugin's own namespace,
 *  - a presets route for the settings card,
 *  - the video-generation proxy (submit / query / cancel) that keeps API
 *    keys host-side,
 *  - FFmpeg processing (probe / frames / gif / compress / concat),
 *  - storyboard studio routes,
 *  - same-origin asset serving, history and library persistence.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { SettingsConflictError, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type { VideoChannel } from './video-engine.ts'
import { generateCoreRoutes } from './routes-generate.ts'
import { processRoutes } from './routes-process.ts'
import { studioRoutes } from './routes-studio.ts'
import { libraryRoutes, historyRoutes } from './routes-store.ts'
import { isLoopbackRequest, writeJson, readJsonBody, messageOf, toView, failureOf, ensureLoopback, methodGuard } from './routes-util.ts'
import { VIDEO_PRESETS } from './video-presets.ts'
import { discoverVideoModels } from './video-models.ts'
import { ENHANCE_API, LLM_MODELS_API, MODEL_API, PRESETS_API, SETTINGS_API, type LlmModelOption } from './protocol.ts'

const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024

/** Settings seam face the bridge needs. */
export interface SettingsSeam {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  mutate(ns: unknown, ops: unknown, expectedRevision?: number): Promise<void>
  readonly writable?: boolean
}

/** The channels view used by routes and the host plugin. */
export interface ChannelsView {
  channels: VideoChannel[]
  defaultChannelId: string
}

/** Route dependencies. */
export interface VideogenRoutesDeps {
  settings: SettingsSeam
  resolveChannels: () => ChannelsView
  /** Whether the auto-save-to-library setting is on. */
  autoSave: () => boolean
  /** 提示词增强：调用 Agent 默认模型，返回增强后的文本。 */
  enhance: (prompt: string, mode: 'text2video' | 'image2video') => Promise<string>
  /** 「设置 → 模型」提供方列表 + 各自可广播模型。 */
  llmModelOptions: () => Promise<LlmModelOption[]>
  /** Resolve a workspace-relative path to an absolute one. */
  resolveWorkspacePath: (workspaceId: string, relativePath: string) => Promise<string>
}

/**
 * Build all web routes for this plugin. Each route is backed by exactly one
 * persisted resource; the composition lives in index.ts.
 */
export function makeRoutes(deps: VideogenRoutesDeps): WebRoute[] {
  const channelsView = deps.resolveChannels

  const requireLoopback = (request: IncomingMessage): void => {
    if (!isLoopbackRequest(request)) throw new Error('settings bridge is loopback-only')
  }

  const routes: WebRoute[] = [
    {
      kind: 'exact',
      path: SETTINGS_API.describe,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        expectLoopbackHandler(req)
        const descriptors = deps.settings.describe({ redactSecrets: true })
        const descriptor = descriptors.find(entry => String(entry.ns) === 'dsh-videogen')
        writeJson(res, 200, descriptor === undefined ? { ns: 'dsh-videogen' } : toView(descriptor))
      },
    },
    {
      kind: 'exact',
      path: SETTINGS_API.mutate,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
        if (body === undefined) {
          writeJson(res, 400, failureOf(new Error('请求体不是合法 JSON')))
          return
        }
        const ns = typeof body.ns === 'string' ? body.ns : ''
        if (ns !== 'dsh-videogen' || !Array.isArray(body.ops)) {
          writeJson(res, 400, failureOf(new Error('malformed bridge settings request')))
          return
        }
        const expectedRevision = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
        await deps.settings.mutate(ns, body.ops as never, expectedRevision)
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: PRESETS_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        writeJson(res, 200, { presets: VIDEO_PRESETS })
      },
    },
    {
      kind: 'exact',
      path: MODEL_API.discover,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
        if (body === undefined || typeof body.channelId !== 'string' || body.channelId === '') {
          writeJson(res, 400, failureOf(new Error('缺少 channelId')))
          return
        }
        // Discovery must work from an unsaved draft too: when the channel is not
        // (yet) in the persisted view, build it from the editor's own fields
        // (preset/apiUrl/key). Persisted values fill the gaps.
        const stored = channelsView().channels.find(entry => entry.id === body.channelId)
        const channel: VideoChannel = {
          id: stored?.id ?? body.channelId,
          preset: typeof body.preset === 'string' && body.preset.trim() !== '' ? body.preset.trim() : (stored?.preset ?? ''),
          name: stored?.name ?? '',
          apiUrl: typeof body.apiUrl === 'string' && body.apiUrl.trim() !== '' ? body.apiUrl.trim() : (stored?.apiUrl ?? ''),
          apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : (stored?.apiKey ?? ''),
          models: stored?.models ?? [],
          authMode: stored?.authMode ?? 'bearer',
          custom: stored?.custom,
        }
        try {
          writeJson(res, 200, await discoverVideoModels(channel))
        } catch (error) {
          writeJson(res, 502, failureOf(error))
        }
      },
    },
    {
      kind: 'exact',
      path: LLM_MODELS_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        writeJson(res, 200, { models: await deps.llmModelOptions() })
      },
    },
    {
      kind: 'exact',
      path: ENHANCE_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'POST')) return
        const body = await readJsonBody(req, MAX_JSON_BODY_BYTES)
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
        if (prompt === '') {
          writeJson(res, 400, failureOf(new Error('缺少 prompt')))
          return
        }
        try {
          writeJson(res, 200, { prompt: await deps.enhance(prompt, 'text2video') })
        } catch (error) {
          writeJson(res, 502, failureOf(error))
        }
      },
    },
  ]

  routes.push(...generateCoreRoutes({ ...deps, channelsView }))
  routes.push(...processRoutes({ ...deps, requireLoopback }))
  routes.push(...studioRoutes({ ...deps, channelsView }))
  routes.push(...historyRoutes())
  routes.push(...libraryRoutes())

  return routes.map(route => ({
    ...route,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await route.handler(req, res)
      } catch (error) {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : undefined)
          return
        }
        const status = error instanceof SettingsConflictError ? 409 : 500
        writeJson(res, status, failureOf(error))
      }
    },
  }))
}

function expectLoopbackHandler(req: IncomingMessage): void {
  if (!isLoopbackRequest(req)) throw new Error('settings bridge is loopback-only')
}

export { ensureLoopback, writeJson, readJsonBody, messageOf, toView, failureOf }
