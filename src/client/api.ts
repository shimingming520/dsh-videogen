/**
 * Browser-side API client for the video generation, process, studio,
 * history and library routes.
 */

import {
  ENHANCE_API, GENERATE_API, HISTORY_API, LIBRARY_API, PRESETS_API, PROCESS_API,
  MODEL_API, STUDIO_API,
  type GenerateVideoRequest, type GenerateResult, type HistoryEntry,
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

  async discoverModels(channelId: string): Promise<{ models: Array<{ alias: string; id: string }>; source: string }> {
    return json<{ models: Array<{ alias: string; id: string }>; source: string }>(await postJson(MODEL_API.discover, { channelId }))
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

  async studioCompose(id: string, transition?: number, audioUrl?: string): Promise<{ ok: boolean; output?: { file: string; url: string }; message?: string }> {
    return json<{ ok: boolean; output?: { file: string; url: string }; message?: string }>(await postJson(STUDIO_API.compose, { id, ...(transition === undefined ? {} : { transition }), ...(audioUrl === undefined ? {} : { audioUrl }) }))
  }

  async studioGenerateAll(id: string, channelId?: string, model?: string): Promise<{ results: Array<{ shotId: string; status: string; taskId?: string; url?: string; error?: string }> }> {
    return json<{ results: Array<{ shotId: string; status: string; taskId?: string; url?: string; error?: string }> }>(await postJson('/api/dsh-videogen/studio/shots/generate', { id, ...(channelId === undefined ? {} : { channelId }), ...(model === undefined ? {} : { model }) }))
  }
}
