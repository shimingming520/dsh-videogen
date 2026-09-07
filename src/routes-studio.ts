/**
 * Storyboard studio route family: templates, project CRUD, shot attach,
 * compose (FFmpeg) and per-shot generation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { STORYBOARD_TEMPLATES, createProjectFromTemplate, updateShot, shotInputs } from './studio-engine.ts'
import { saveProject, loadProject, listProjects, removeProject, PROCESS_OUTPUT_DIR } from './video-store.ts'
import { concatSegments } from './process-engine.ts'
import { runGeneration, parseGenerateRequest } from './generate-core.ts'
import type { VideoChannel } from './video-engine.ts'
import { VideoGenError } from './video-engine.ts'
import { writeJson, readJsonBody, methodGuard } from './routes-util.ts'
import { STUDIO_API, type GenerateVideoRequest, type StoryboardProject } from './protocol.ts'

export interface ChannelsView {
  channels: VideoChannel[]
  defaultChannelId: string
}

export interface StudioRouteDeps {
  channelsView: () => ChannelsView
  autoSave: () => boolean
  enhance: (prompt: string, mode: 'text2video' | 'image2video') => Promise<string>
}

function resolveChannelFor(view: ChannelsView, channelId: string | undefined): VideoChannel {
  const target = channelId !== undefined && channelId !== '' ? channelId : view.defaultChannelId
  const channel = view.channels.find(entry => entry.id === target) ?? view.channels[0]
  if (channel === undefined) throw new VideoGenError('尚未配置任何视频生成渠道', 'video-no-channel')
  return channel
}

export function studioRoutes(deps: StudioRouteDeps): WebRoute[] {
  const routes: WebRoute[] = []

  routes.push({
    kind: 'exact',
    path: STUDIO_API.templates,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'GET')) return
      writeJson(res, 200, { templates: STORYBOARD_TEMPLATES })
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.projects,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'GET')) return
      writeJson(res, 200, { projects: await listProjects() })
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.projects,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const templateId = typeof body?.templateId === 'string' ? body.templateId : ''
      if (templateId === '') {
        writeJson(res, 400, { ok: false, code: 'bad-template', message: '缺少 templateId' })
        return
      }
      const vars: Record<string, string> = {}
      if (typeof body?.vars === 'object' && body.vars !== null) {
        for (const [key, value] of Object.entries(body.vars as Record<string, unknown>)) {
          if (typeof value === 'string') vars[key] = value
        }
      }
      const name = typeof body?.name === 'string' && body.name.trim() !== '' ? body.name.trim() : `${templateId}-${new Date().toISOString().slice(0, 10)}`
      try {
        const project = createProjectFromTemplate(templateId, name, vars)
        await saveProject(project)
        writeJson(res, 200, project)
      } catch (error) {
        writeJson(res, 400, { ok: false, code: 'bad-template', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.project,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'GET')) return
      const url = new URL(req.url ?? STUDIO_API.project, 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const project = await loadProject(id)
      if (project === undefined) {
        writeJson(res, 404, { ok: false, code: 'not-found', message: '项目不存在' })
        return
      }
      writeJson(res, 200, project)
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.project,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'PUT')) return
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id : ''
      const project = await loadProject(id)
      if (project === undefined) {
        writeJson(res, 404, { ok: false, code: 'not-found', message: '项目不存在' })
        return
      }
      let next = project
      if (typeof body?.shotId === 'string' && body.shotId !== '') {
        const patch: Record<string, unknown> = {}
        if (typeof body?.prompt === 'string') patch.prompt = body.prompt
        if (typeof body?.name === 'string') patch.name = body.name
        if (typeof body?.duration === 'number') patch.duration = body.duration
        if (typeof body?.transition === 'number') patch.transition = body.transition
        if (typeof body?.imageUrl === 'string') patch.imageUrl = body.imageUrl
        if (typeof body?.videoUrl === 'string' && body.videoUrl !== '') {
          const shots = next.shots.map(shot => shot.id === body.shotId ? { ...shot, videoUrl: String(body.videoUrl), status: 'ready' as const } : shot)
          next = { ...next, shots, updatedAt: Date.now() }
        }
        if (Object.keys(patch).length > 0) {
          next = updateShot(next, body.shotId, patch as never)
        }
      } else if (Array.isArray(body?.shots)) {
        next = { ...next, shots: body.shots as never, updatedAt: Date.now() }
      }
      if (typeof body?.name === 'string' && body.name !== '') next = { ...next, name: body.name }
      await saveProject(next)
      writeJson(res, 200, next)
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.project,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'DELETE')) return
      const url = new URL(req.url ?? STUDIO_API.project, 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      await removeProject(id)
      writeJson(res, 200, { ok: true })
    },
  })

  routes.push({
    kind: 'exact',
    path: STUDIO_API.compose,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id : ''
      const project = await loadProject(id)
      if (project === undefined) {
        writeJson(res, 404, { ok: false, code: 'not-found', message: '项目不存在' })
        return
      }
      const segments = shotInputs(project)
      if (segments.length === 0) {
        writeJson(res, 400, { ok: false, code: 'no-shots-ready', message: '没有已生成的镜头（请先生成或附加视频素材）' })
        return
      }
      const transition = typeof body?.transition === 'number' ? body.transition : undefined
      const audioUrl = typeof body?.audioUrl === 'string' && body.audioUrl.trim() !== '' ? body.audioUrl.trim() : undefined
      const outFile = `studio_${project.id.slice(0, 8)}.mp4`
      const outPath = `${PROCESS_OUTPUT_DIR}/${outFile}`
      try {
        await concatSegments(segments, {
          outPath,
          width: aspectWidth(project.aspectRatio),
          height: aspectHeight(project.aspectRatio),
          transition,
          audioUrl,
        })
        writeJson(res, 200, { ok: true, projectId: project.id, output: { file: outFile, url: `/api/dsh-videogen/assets/output/${encodeURIComponent(outFile)}` } })
      } catch (error) {
        writeJson(res, 500, { ok: false, code: 'compose-failed', message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  routes.push({
    kind: 'exact',
    path: '/api/dsh-videogen/studio/shots/generate',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!methodGuard(req, res, 'POST')) return
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id : ''
      const project = await loadProject(id)
      if (project === undefined) {
        writeJson(res, 404, { ok: false, code: 'not-found', message: '项目不存在' })
        return
      }
      const channel = resolveChannelFor(deps.channelsView(), typeof body?.channelId === 'string' ? body.channelId : undefined)
      const waitSeconds = typeof body?.waitSeconds === 'number' ? body.waitSeconds : 120
      const results: Array<{ shotId: string; status: string; error?: string }> = []
      for (const shot of project.shots) {
        if (shot.status === 'ready') {
          results.push({ shotId: shot.id, status: 'ready' })
          continue
        }
        try {
          const request: GenerateVideoRequest = {
            mode: shot.imageUrl !== undefined && shot.imageUrl !== '' ? 'image2video' : 'text2video',
            prompt: shot.prompt,
            ...(shot.imageUrl !== undefined ? { image: shot.imageUrl } : {}),
            ...(typeof body?.model === 'string' && body.model !== '' ? { model: body.model } : {}),
            aspectRatio: project.aspectRatio,
            duration: shot.duration,
          }
          const result = await runGeneration({
            channel,
            request,
            wait: true,
            waitSeconds,
            autoSave: deps.autoSave,
          })
          if (result.status === 'completed' && result.videos.length > 0) {
            const shots = project.shots.map(item => item.id === shot.id ? { ...item, videoUrl: result.videos[0]!.url, status: 'ready' as const, error: undefined } : item)
            const next: StoryboardProject = { ...project, shots, updatedAt: Date.now() }
            await saveProject(next)
            results.push({ shotId: shot.id, status: 'ready' })
          } else {
            const shots = project.shots.map(item => item.id === shot.id ? { ...item, status: 'failed' as const, error: result.error ?? '生成未完成（任务可能仍在处理中）' } : item)
            await saveProject({ ...project, shots, updatedAt: Date.now() })
            results.push({ shotId: shot.id, status: 'failed', error: result.error ?? '任务未完成' })
          }
        } catch (error) {
          results.push({ shotId: shot.id, status: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
      }
      writeJson(res, 200, { results, project: await loadProject(id) })
    },
  })

  return routes
}

function aspectWidth(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number)
  if (w === undefined || h === undefined || h === 0) return 1280
  return w / h >= 1 ? 1280 : 720
}

function aspectHeight(aspect: string): number {
  const [w, h] = aspect.split(':').map(Number)
  if (w === undefined || h === undefined || h === 0 || w === 0) return 720
  return w / h >= 1 ? 720 : 1280
}
