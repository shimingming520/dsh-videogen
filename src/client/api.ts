/**
 * Browser-side API client for the video generation, process, studio,
 * history and library routes.
 */

import {
  ENHANCE_API, GENERATE_API, HISTORY_API, LIBRARY_API, PRESETS_API, PROCESS_API,
  MODEL_API, STUDIO_API,
  type DiscoveredVideoModel, type GenerateVideoRequest, type GenerateResult, type HistoryEntry,
  type LibraryEntry, type ProcessRequest, type ProcessResult, type StoryboardProject,
  type StoryboardTemplate, type VideoChannelConfig,
} from '../protocol.ts'

/** POST helper: the host API requires the JSON content type on every POST. */
function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T
  return body
}

export interface ChannelView extends VideoChannelConfig {
  apiKey: string
  custom: never
}

export class VideogenApi {
  async generate(request: GenerateVideoRequest, signal?: AbortSignal): Promise<GenerateResult> {
    return json<GenerateResult>(await postJson(GENERATE_API.start, request, signal))
  }

  async queryTask(taskId: string, channelId?: string): Promise<GenerateResult> {
    return json<GenerateResult>(await postJson(GENERATE_API.query, { taskId, ...(channelId === undefined ? {} : { channelId }) }))
  }

  /** 提示词增强（复用 Agent 默认模型）。 */
  async enhancePrompt(prompt: string): Promise<{ ok: boolean; enhanced?: string; code?: string; message?: string }> {
    const response = await postJson(ENHANCE_API, { prompt })
    const body = await json<{ ok?: boolean; enhanced?: string; code?: string; message?: string }>(response)
    return { ok: body.ok === true, ...(body.enhanced === undefined ? {} : { enhanced: body.enhanced }), ...(body.code === undefined ? {} : { code: body.code }), ...(body.message === undefined ? {} : { message: body.message }) }
  }

  async presets(): Promise<Array<{ id: string; name: string; apiUrl: string; description: string; aspectRatios?: string[]; durations?: number[]; custom?: Record<string, unknown> }>> {
    const body = await json<{ presets: Array<{ id: string; name: string; apiUrl: string; description: string; aspectRatios?: string[]; durations?: number[]; custom?: Record<string, unknown> }> }>(await fetch(PRESETS_API))
    return body.presets
  }

  async discoverModels(channelId: string, draft?: { preset?: string; apiUrl?: string; apiKey?: string }): Promise<{ models: DiscoveredVideoModel[]; source: string }> {
    return json<{ models: DiscoveredVideoModel[]; source: string }>(await postJson(MODEL_API.discover, {
      channelId,
      ...(draft?.preset === undefined ? {} : { preset: draft.preset }),
      ...(draft?.apiUrl === undefined ? {} : { apiUrl: draft.apiUrl }),
      ...(draft?.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
    }))
  }

  /** Upload a browser file (name + base64) for local processing. */
  async uploadFile(name: string, base64: string): Promise<{ ok: boolean; file?: string; url?: string; mime?: string; bytes?: number; code?: string; message?: string }> {
    const response = await postJson('/api/dsh-videogen/upload', { name, data: base64 })
    const body = await json<{ ok?: boolean; file?: string; url?: string; mime?: string; bytes?: number; code?: string; message?: string }>(response)
    return { ok: body.ok === true, ...(body.file === undefined ? {} : { file: body.file }), ...(body.url === undefined ? {} : { url: body.url }), ...(body.mime === undefined ? {} : { mime: body.mime }), ...(body.bytes === undefined ? {} : { bytes: body.bytes }), ...(body.code === undefined ? {} : { code: body.code }), ...(body.message === undefined ? {} : { message: body.message }) }
  }

  async historyList(): Promise<HistoryEntry[]> {
    return json<{ entries: HistoryEntry[] }>(await fetch(HISTORY_API)).then(body => body.entries ?? [])
  }

  async libraryList(): Promise<LibraryEntry[]> {
    return json<{ entries: LibraryEntry[] }>(await fetch(LIBRARY_API)).then(body => body.entries ?? [])
  }

  async processRun(request: ProcessRequest, signal?: AbortSignal): Promise<ProcessResult> {
    return json<ProcessResult>(await postJson(PROCESS_API, request, signal))
  }

  async studioTemplates(): Promise<StoryboardTemplate[]> {
    return json<{ templates: StoryboardTemplate[] }>(await fetch(STUDIO_API.templates)).then(body => body.templates ?? [])
  }

  async studioProjects(): Promise<StoryboardProject[]> {
    return json<{ projects: StoryboardProject[] }>(await fetch(STUDIO_API.projects)).then(body => body.projects ?? [])
  }

  async studioCreate(templateId: string, name: string, vars: Record<string, string>): Promise<StoryboardProject> {
    return json<StoryboardProject>(await postJson(STUDIO_API.projects, { templateId, name, vars }))
  }

  async studioGet(id: string): Promise<StoryboardProject | undefined> {
    const response = await fetch(`${STUDIO_API.project}?id=${encodeURIComponent(id)}`)
    if (response.status === 404) return undefined
    return json<StoryboardProject>(response)
  }

  async studioUpdate(id: string, shotId: string | undefined, patch: Record<string, unknown>): Promise<StoryboardProject> {
    return json<StoryboardProject>(await (async () => {
      if (shotId !== undefined) {
        return fetch(STUDIO_API.project, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, shotId, ...patch }) })
      }
      return fetch(STUDIO_API.project, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...patch }) })
    })())
  }

  async studioCompose(id: string, transition?: number, audioUrl?: string): Promise<{ ok: boolean; status?: string; output?: { file: string; url: string }; message?: string; code?: string }> {
    return json<{ ok: boolean; status?: string; output?: { file: string; url: string }; message?: string; code?: string }>(await postJson(STUDIO_API.compose, { id, ...(transition === undefined ? {} : { transition }), ...(audioUrl === undefined ? {} : { audioUrl }) }))
  }

  async studioComposeStatus(id: string): Promise<{ status: string; output?: { file: string; url: string }; error?: string }> {
    return json<{ status: string; output?: { file: string; url: string }; error?: string }>(await fetch(`/api/dsh-videogen/studio/compose/status?id=${encodeURIComponent(id)}`))
  }

  async studioComposeCancel(id: string): Promise<{ ok: boolean; message?: string }> {
    return json<{ ok: boolean; message?: string }>(await postJson('/api/dsh-videogen/studio/compose/cancel', { id }))
  }

  async templatePreview(templateId: string, vars: Record<string, string>, mode?: 'auto' | 'local', signal?: AbortSignal): Promise<{ ok: boolean; thumb?: string; prompt?: string; cached?: boolean; code?: string; message?: string }> {
    const response = await postJson('/api/dsh-videogen/studio/template-preview', { templateId, vars, ...(mode === undefined ? {} : { mode }) }, signal)
    return json<{ ok: boolean; thumb?: string; prompt?: string; cached?: boolean; code?: string; message?: string }>(response)
  }

  async libraryUpdate(id: string, patch: { name?: string; tags?: string[]; category?: string }): Promise<LibraryEntry[]> {
    const response = await fetch(LIBRARY_API, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...patch }) })
    const body = await json<{ entries: LibraryEntry[] }>(response)
    return body.entries ?? []
  }

  async libraryDelete(id: string): Promise<LibraryEntry[]> {
    const body = await json<{ entries: LibraryEntry[] }>(await postJson(LIBRARY_API, { id })) 
    return body.entries ?? []
  }

  async studioGenerateAll(id: string, channelId?: string, model?: string): Promise<{ results: Array<{ shotId: string; status: string; taskId?: string; url?: string; error?: string }> }> {
    return json<{ results: Array<{ shotId: string; status: string; taskId?: string; url?: string; error?: string }> }>(await postJson('/api/dsh-videogen/studio/shots/generate', { id, ...(channelId === undefined ? {} : { channelId }), ...(model === undefined ? {} : { model }) }))
  }
}
