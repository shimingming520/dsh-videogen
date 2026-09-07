/**
 * Generation route family: start / query / cancel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { VideoChannel } from './video-engine.ts'
import { VideoGenError } from './video-engine.ts'
import { runGeneration, queryGeneration, cancelGeneration, parseGenerateRequest } from './generate-core.ts'
import { writeJson, readJsonBody, methodGuard } from './routes-util.ts'
import { GENERATE_API } from './protocol.ts'

export interface ChannelsView {
  channels: VideoChannel[]
  defaultChannelId: string
}

export interface GenerateRouteDeps {
  channelsView: () => ChannelsView
  autoSave: () => boolean
  enhance: (prompt: string, mode: 'text2video' | 'image2video') => Promise<string>
}

function resolveChannelFor(view: ChannelsView, channelId: string | undefined): VideoChannel {
  const target = channelId !== undefined && channelId !== '' ? channelId : view.defaultChannelId
  const channel = view.channels.find(entry => entry.id === target) ?? view.channels[0]
  if (channel === undefined) throw new VideoGenError('尚未配置任何视频生成渠道（设置 → 插件 → AI 视频）', 'video-no-channel')
  if (channel.apiKey.trim() === '') throw new VideoGenError(`渠道「${channel.name}」未配置 API 密钥`, 'video-no-key')
  return channel
}

function ensureLoopbackGenerate(req: IncomingMessage): void {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') throw new Error('生成代理仅限本机访问')
}

export function generateCoreRoutes(deps: GenerateRouteDeps): WebRoute[] {
  const routes: WebRoute[] = []

  // 在途任务的取消信号表（面板/工具可取消等待中的上游轮询）。
  const aborts = new Map<string, AbortController>()

  routes.push({
    kind: 'exact',
    path: GENERATE_API.start,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      ensureLoopbackGenerate(req)
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: 'bad-body', message: '请求体不是合法 JSON' })
        return
      }
      const request = parseGenerateRequest(body)
      if (request === undefined) {
        writeJson(res, 400, { ok: false, code: 'bad-prompt', message: '缺少 prompt' })
        return
      }
      const channel = resolveChannelFor(deps.channelsView(), request.channelId)
      if (request.enhancePrompt === true) {
        request.prompt = await deps.enhance(request.prompt, request.mode)
      }
      const controller = new AbortController()
      const wait = body.wait !== false
      const waitSeconds = typeof body.waitSeconds === 'number' ? body.waitSeconds : undefined
      const result = await runGeneration({
        channel,
        request,
        wait,
        waitSeconds,
        autoSave: deps.autoSave,
        signal: controller.signal,
      })
      if (result.taskId !== undefined) aborts.set(result.taskId, controller)
      writeJson(res, 200, result)
    },
  })

  routes.push({
    kind: 'exact',
    path: GENERATE_API.query,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
      const channelId = typeof body?.channelId === 'string' ? body.channelId.trim() : ''
      if (taskId === '') {
        writeJson(res, 400, { ok: false, code: 'bad-task', message: '缺少 taskId' })
        return
      }
      try {
        const channel = resolveChannelFor(deps.channelsView(), channelId)
        const result = await queryGeneration(channel, taskId, {})
        if (result.taskId !== undefined) aborts.get(result.taskId)?.abort()
        aborts.delete(taskId)
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { ok: false, code: 'video-task-unknown', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  routes.push({
    kind: 'exact',
    path: GENERATE_API.cancel,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
      if (taskId === '') {
        writeJson(res, 400, { ok: false, code: 'bad-task', message: '缺少 taskId' })
        return
      }
      aborts.get(taskId)?.abort()
      aborts.delete(taskId)
      writeJson(res, 200, await cancelGeneration(taskId))
    },
  })

  return routes
}
