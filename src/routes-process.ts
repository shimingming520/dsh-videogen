/**
 * Processing route family: FFmpeg actions on URLs / paths / workspace files.
 */

import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { runProcessAction, ProcessError } from './process-engine.ts'
import { PROCESS_OUTPUT_DIR, readDataFile } from './video-store.ts'
import { writeJson, readJsonBody, methodGuard } from './routes-util.ts'
import { ASSETS_API, PROCESS_API } from './protocol.ts'

export interface ProcessRouteDeps {
  /** Resolve a workspace-relative path (ws/<workspaceId>/<path>) to absolute. */
  resolveWorkspacePath: (workspaceId: string, relativePath: string) => Promise<string>
  requireLoopback: (req: IncomingMessage) => void
}

const WS_PREFIX = 'ws:'

async function resolveInput(value: string, resolveWorkspacePath: ProcessRouteDeps['resolveWorkspacePath']): Promise<string> {
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith(WS_PREFIX)) {
    const rest = trimmed.slice(WS_PREFIX.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) throw new ProcessError('ws: 前缀格式应为 ws:<workspaceId>/<relativePath>', 'bad-input')
    const workspaceId = rest.slice(0, slash)
    const relative = rest.slice(slash + 1)
    const absolute = await resolveWorkspacePath(workspaceId, relative)
    if (!existsSync(absolute)) throw new ProcessError(`工作区文件不存在: ${relative}`, 'bad-input')
    return absolute
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    if (!existsSync(trimmed)) throw new ProcessError(`文件不存在: ${trimmed}`, 'bad-input')
    return trimmed
  }
  // Relative path: try as-is under cwd if present.
  if (existsSync(trimmed)) return trimmed
  throw new ProcessError(`无法解析输入（支持 http(s) URL、绝对路径、ws:<workspaceId>/<path>）: ${trimmed}`, 'bad-input')
}

export function processRoutes(deps: ProcessRouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: PROCESS_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'POST')) return
        const body = await readJsonBody(req, 32 * 1024 * 1024)
        if (body === undefined || typeof body.action !== 'string') {
          writeJson(res, 400, { ok: false, code: 'bad-action', message: '缺少 action' })
          return
        }
        const action = body.action
        if (action !== 'info' && action !== 'frames' && action !== 'gif' && action !== 'compress' && action !== 'concat') {
          writeJson(res, 400, { ok: false, code: 'bad-action', message: `未知 action: ${String(action)}` })
          return
        }
        try {
          const input = typeof body.input === 'string' ? await resolveInput(body.input, deps.resolveWorkspacePath) : undefined
          const inputs = Array.isArray(body.inputs)
            ? await Promise.all((body.inputs as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => resolveInput(item, deps.resolveWorkspacePath)))
            : undefined
          const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
          const result = await runProcessAction({
            action,
            input,
            inputs,
            count: num(body.count),
            at: num(body.at),
            width: num(body.width),
            quality: num(body.quality),
            start: num(body.start),
            duration: num(body.duration),
            fps: num(body.fps),
            transition: num(body.transition),
            audioUrl: typeof body.audioUrl === 'string' && body.audioUrl.trim() !== '' ? body.audioUrl.trim() : undefined,
            outDir: PROCESS_OUTPUT_DIR,
          })
          // Map outputs to same-origin URLs.
          if (result.frames !== undefined) {
            result.frames = result.frames.map(frame => ({ ...frame, url: `${ASSETS_API}/output/${encodeURIComponent(frame.file)}` }))
          }
          if (result.output !== undefined) {
            result.output = { ...result.output, url: `${ASSETS_API}/output/${encodeURIComponent(result.output.file)}` }
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, error instanceof ProcessError ? 500 : 500, { ok: false, code: error instanceof ProcessError ? error.code : 'video-process-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'prefix',
      path: ASSETS_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        const url = new URL(req.url ?? ASSETS_API, 'http://localhost')
        const rest = url.pathname.slice(ASSETS_API.length).replace(/^\/+/, '')
        const parts = rest.split('/')
        if (parts.length !== 2) {
          writeJson(res, 404, { ok: false, code: 'not-found', message: '资源路径不合法' })
          return
        }
        const kind = parts[0]
        const file = decodeURIComponent(parts[1] ?? '')
        if (kind !== 'videos' && kind !== 'output' && kind !== 'library') {
          writeJson(res, 404, { ok: false, code: 'not-found', message: '未知资源类型' })
          return
        }
        const asset = await readDataFile(kind as 'videos' | 'output' | 'library', file)
        if (asset === undefined) {
          writeJson(res, 404, { ok: false, code: 'not-found', message: '资源不存在' })
          return
        }
        res.writeHead(200, {
          'content-type': asset.mime,
          'content-length': String(asset.data.byteLength),
          'cache-control': 'public, max-age=86400',
          'access-control-allow-origin': '*',
        })
        res.end(asset.data)
      },
    },
  ]
}
