/**
 * History and library route families.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { listHistory, removeHistory, clearHistory, listLibrary, upsertLibrary, removeLibrary } from './video-store.ts'
import { writeJson, readJsonBody, methodGuard } from './routes-util.ts'
import { HISTORY_API, LIBRARY_API, LIBRARY_TYPES, type LibraryType } from './protocol.ts'

export function historyRoutes(): WebRoute[] {
  return [
    {
      kind: 'prefix',
      path: HISTORY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        const url = new URL(req.url ?? HISTORY_API, 'http://localhost')
        if (url.pathname === HISTORY_API || url.pathname === `${HISTORY_API}/`) {
          writeJson(res, 200, { entries: await listHistory() })
          return
        }
        const taskId = decodeURIComponent(url.pathname.slice(HISTORY_API.length + 1))
        const entry = (await listHistory()).find(item => item.taskId === taskId)
        if (entry === undefined) {
          writeJson(res, 404, { ok: false, code: 'not-found', message: '历史记录不存在' })
          return
        }
        writeJson(res, 200, entry)
      },
    },
    {
      kind: 'prefix',
      path: HISTORY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'DELETE')) return
        const url = new URL(req.url ?? HISTORY_API, 'http://localhost')
        const taskId = decodeURIComponent(url.pathname.slice(HISTORY_API.length + 1)).replace(/^\/+/, '')
        if (taskId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-id', message: '缺少任务 id' })
          return
        }
        writeJson(res, 200, { entries: await removeHistory(taskId) })
      },
    },
    {
      kind: 'exact',
      path: HISTORY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'DELETE')) return
        await clearHistory()
        writeJson(res, 200, { ok: true })
      },
    },
  ]
}

export function libraryRoutes(): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: LIBRARY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'GET')) return
        writeJson(res, 200, { entries: await listLibrary() })
      },
    },
    {
      kind: 'exact',
      path: LIBRARY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const type = LIBRARY_TYPES.includes(body?.type as LibraryType) ? body?.type as LibraryType : undefined
        if (type === undefined || typeof body?.name !== 'string' || body.name.trim() === '') {
          writeJson(res, 400, { ok: false, code: 'bad-entry', message: '缺少 type/name' })
          return
        }
        const entry = {
          id: randomUUID(),
          type,
          name: body.name.trim(),
          ...(Array.isArray(body?.tags) ? { tags: (body.tags as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 12) } : {}),
          ...(typeof body?.category === 'string' && body.category.trim() !== '' ? { category: body.category.trim() } : {}),
          ...(typeof body?.file === 'string' && body.file.trim() !== '' ? { file: body.file.trim() } : {}),
          ...(typeof body?.url === 'string' && body.url.trim() !== '' ? { url: body.url.trim() } : {}),
          provenance: {
            createdAt: Date.now(),
          },
          createdAt: Date.now(),
        }
        writeJson(res, 200, await upsertLibrary(entry))
      },
    },
    {
      kind: 'exact',
      path: LIBRARY_API,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!methodGuard(req, res, 'DELETE')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 400, { ok: false, code: 'bad-id', message: '缺少 id' })
          return
        }
        writeJson(res, 200, { entries: await removeLibrary(id) })
      },
    },
  ]
}
