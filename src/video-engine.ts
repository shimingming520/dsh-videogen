/**
 * Upstream video generation proxy engine.
 *
 * Normalizes the vendors behind one interface: submit a text2video /
 * image2video request, get a serializable task reference, then poll it
 * until completion. Result video URLs are raw upstream URLs; the store
 * layer downloads and re-hosts them same-origin. API keys never leave the
 * host process.
 */

import { createHmac } from 'node:crypto'
import type { GenerateVideoRequest, TaskRef, TaskStatus } from './protocol.ts'

/** Resolved channel (key included; never logged). */
export interface VideoChannel {
  id: string
  preset: string
  name: string
  apiUrl: string
  apiKey: string
  models: Array<{ alias: string; id: string }>
  authMode: 'bearer' | 'jwt'
  custom: {
    submitUrl: string
    bodyTemplate?: string
    taskIdPath?: string
    pollUrlTemplate?: string
    pollMethod?: string
    statusPath?: string
    doneValues?: string
    failValues?: string
    resultUrlPath?: string
    apiKeyHeader?: string
    apiKeyScheme?: string
  } | undefined
}

/** A video generation failure with a user-presentable message. */
export class VideoGenError extends Error {
  readonly code: string

  constructor(message: string, code = 'video-generate-failed') {
    super(message)
    this.name = 'VideoGenError'
    this.code = code
  }
}

/** Total budget for one upstream submit/probe call. */
const UPSTREAM_TIMEOUT_MS = 60_000
/** Budget for downloading one result video URL. */
const VIDEO_FETCH_TIMEOUT_MS = 300_000

function requestSignal(source: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromSource = () => { controller.abort(source?.reason) }
  if (source?.aborted === true) abortFromSource()
  else source?.addEventListener('abort', abortFromSource, { once: true })
  const timeout = setTimeout(() => { controller.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, timeoutMs)
  timeout.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      source?.removeEventListener('abort', abortFromSource)
    },
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<unknown> {
  const budget = requestSignal(init.signal as AbortSignal | undefined, timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: budget.signal })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new VideoGenError(`视频 API 错误 (HTTP ${response.status})${text === '' ? '' : `: ${text.slice(0, 300)}`}`, 'video-api-error')
    }
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new VideoGenError('视频端点返回了无法解析的响应体', 'video-bad-response')
    }
  } finally {
    budget.dispose()
  }
}

function isPreset(channel: VideoChannel, id: string): boolean {
  return channel.preset === id || channel.apiUrl.toLowerCase().includes(id)
}

function endpointBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Resolve the API root used for {{base}} substitution. */
function apiRoot(url: string): string {
  const trimmed = endpointBase(url)
  // Keep query params (e.g. MiniMax ?GroupId=xxx) out of path building.
  const index = trimmed.indexOf('?')
  return index >= 0 ? trimmed.slice(0, index) : trimmed
}

/* ------------------------------------------------------------------ */
/*  helpers: dot paths & url extraction                                */
/* ------------------------------------------------------------------ */

/** Read a dot path like "data.videos[0].url" from a JSON value. */
export function dotPath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter(segment => segment !== '')
  let current: unknown = value
  for (const segment of segments) {
    const indexMatch = /^([^\[\]]+)\[(\d+)\]$/.exec(segment)
    if (indexMatch !== null) {
      if (current === null || typeof current !== 'object') return undefined
      const key = indexMatch[1]
      const record = current as Record<string, unknown>
      const arr = record[key]
      if (!Array.isArray(arr)) return undefined
      current = arr[Number(indexMatch[2])]
      continue
    }
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Substitute {{placeholders}} in a template string. */
export function substituteTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim()
    return Object.prototype.hasOwnProperty.call(values, trimmed) ? values[trimmed] : match
  })
}

/** Recursively find the first http(s) URL in a JSON payload. */
export function findUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrl(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['url', 'video_url', 'download_url', 'href', 'link', 'video', 'data', 'result', 'value']) {
    const found = findUrl(record[key])
    if (found !== undefined) return found
  }
  return undefined
}

/** Read one of several dot paths; first hit wins. */
function firstPath(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const hit = dotPath(value, path)
    if (typeof hit === 'string' && hit.trim() !== '') return hit.trim()
  }
  return undefined
}

/** Whether a whole payload is or contains a ready video URL. */
function completionUrls(value: unknown, resultUrlPaths: string[]): string[] {
  const direct = findUrl(value)
  const viaPath = firstPath(value, resultUrlPaths)
  const picked = viaPath !== undefined ? [viaPath] : direct !== undefined ? [direct] : []
  const urls = new Set<string>()
  for (const url of picked) urls.add(url)
  return [...urls]
}

/* ------------------------------------------------------------------ */
/*  Kling JWT (HS256)                                                  */
/* ------------------------------------------------------------------ */

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build the standard Kling JWT from accessKey + secretKey. */
export function klingJwt(accessKey: string, secretKey: string, ttlSeconds = 1800): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 }))
  const signature = createHmac('sha256', secretKey).update(`${header}.${payload}`).digest()
  return `${header}.${payload}.${base64url(signature)}`
}

/** Kling layout: "AccessKey:SecretKey" → JWT; anything else → Bearer. */
function klingAuth(channel: VideoChannel): string {
  const value = channel.apiKey.trim()
  const separator = value.indexOf(':')
  // "AccessKey:SecretKey" → JWT signing; anything else is a plain bearer token.
  if (separator > 0 && separator < value.length - 1) {
    const accessKey = value.slice(0, separator).trim()
    const secretKey = value.slice(separator + 1).trim()
    return `Bearer ${klingJwt(accessKey, secretKey)}`
  }
  return `Bearer ${value}`
}

function bearer(channel: VideoChannel): string {
  return `Bearer ${channel.apiKey.trim()}`
}

/* ------------------------------------------------------------------ */
/*  status normalization                                               */
/* ------------------------------------------------------------------ */

interface RawTaskState {
  status: TaskStatus
  videos: string[]
  error?: string
}

function inProgress(): RawTaskState {
  return { status: 'processing', videos: [] }
}

function completed(videos: string[]): RawTaskState {
  return { status: 'completed', videos }
}

function failed(message: string): RawTaskState {
  return { status: 'failed', videos: [], error: message }
}

/* ------------------------------------------------------------------ */
/*  OpenAI compatible /v1/videos (Sora spec)                           */
/* ------------------------------------------------------------------ */

async function submitOpenAI(channel: VideoChannel, request: GenerateVideoRequest, signal?: AbortSignal): Promise<{ ref: TaskRef | undefined; immediate: string[] }> {
  const base = apiRoot(channel.apiUrl)
  const endpoint = /\/videos(\?|$)/i.test(base) ? base : `${base}/videos`
  const body: Record<string, unknown> = {
    model: channelModel(channel, request.model) ?? 'sora-2',
    prompt: request.prompt,
  }
  if (request.image !== undefined && request.image !== '') body.image = request.image
  if (request.negativePrompt !== undefined && request.negativePrompt !== '') body.negative_prompt = request.negativePrompt
  if (request.resolution !== undefined && request.resolution !== '') body.size = request.resolution
  if (request.duration !== undefined) body.seconds = request.duration
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: bearer(channel), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const immediate = completionUrls(payload, ['data[0].url', 'data[0].content_url', 'url', 'video_url'])
  const taskId = firstPath(payload, ['id', 'data.id', 'task_id'])
  if (taskId === undefined) {
    if (immediate.length > 0) return { ref: undefined, immediate }
    throw new VideoGenError('OpenAI 兼容视频端点未返回任务 id 或结果 URL', 'video-no-task')
  }
  return {
    ref: {
      kind: 'openai',
      taskId,
      pollUrl: `${base}/videos/${encodeURIComponent(taskId)}`,
      pollMethod: 'GET',
      statusPath: 'status',
      doneValues: 'completed,succeeded,success',
      failValues: 'failed,error,cancelled,failed_req',
      resultUrlPath: 'data[0].url,data[0].content_url,data,url,video_url',
    },
    immediate,
  }
}

async function queryOpenAI(channel: VideoChannel, ref: TaskRef, signal?: AbortSignal): Promise<RawTaskState> {
  const url = ref.pollUrl ?? ''
  const payload = await fetchJson(url, { method: ref.pollMethod === 'POST' ? 'POST' : 'GET', headers: { authorization: bearer(channel) }, signal })
  const status = typeof dotPath(payload, ref.statusPath ?? 'status') === 'string'
    ? String(dotPath(payload, ref.statusPath ?? 'status')).toLowerCase()
    : ''
  if (ref.failValues !== undefined && ref.failValues.split(',').map(s => s.trim().toLowerCase()).includes(status)) {
    const error = typeof dotPath(payload, 'error.message') === 'string' ? String(dotPath(payload, 'error.message')) : typeof dotPath(payload, 'error') === 'string' ? String(dotPath(payload, 'error')) : undefined
    return failed(error ?? `上游任务失败 (${status})`)
  }
  if (ref.doneValues !== undefined && ref.doneValues.split(',').map(s => s.trim().toLowerCase()).includes(status)) {
    const urls = completionUrls(payload, (ref.resultUrlPath ?? 'data[0].url,data[0].content_url,data,url,video_url').split(',').map(s => s.trim()).filter(s => s !== ''))
    if (urls.length === 0) return { status: 'processing', videos: [] }
    return completed(urls)
  }
  if (status === '') {
    // Some gateways answer with the video in the same shape on every poll.
    const urls = completionUrls(payload, (ref.resultUrlPath ?? 'data[0].url,data[0].content_url,data,url,video_url').split(',').map(s => s.trim()).filter(s => s !== ''))
    if (urls.length > 0) return completed(urls)
    return inProgress()
  }
  return inProgress()
}

/* ------------------------------------------------------------------ */
/*  Kling                                                              */
/* ------------------------------------------------------------------ */

function channelModel(channel: VideoChannel, raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const model = channel.models.find(model => model.alias === raw || model.id === raw)
  return model?.id ?? raw.trim()
}

async function submitKling(channel: VideoChannel, request: GenerateVideoRequest, signal?: AbortSignal): Promise<{ ref: TaskRef | undefined; immediate: string[] }> {
  const base = apiRoot(channel.apiUrl)
  const auth = klingAuth(channel)
  const isI2V = request.mode === 'image2video'
  const endpoint = `${base}/v1/videos/${isI2V ? 'image2video' : 'text2video'}`
  const body: Record<string, unknown> = {
    model_name: channelModel(channel, request.model) ?? 'kling-v1-6',
    prompt: request.prompt,
  }
  if (isI2V) body.image = request.image ?? ''
  if (request.negativePrompt !== undefined && request.negativePrompt !== '') body.negative_prompt = request.negativePrompt
  if (request.aspectRatio !== undefined && request.aspectRatio !== '') body.aspect_ratio = request.aspectRatio
  if (request.duration !== undefined) body.duration = String(request.duration)
  if (request.seed !== undefined) body.seed = request.seed
  // kling-v2+ uses mode instead of width/height fields; keep it simple.
  if (request.resolution !== undefined && request.resolution !== '') body.size = request.resolution
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const code = Number(dotPath(payload, 'code') ?? 0)
  if (code !== 0) {
    const message = dotPath(payload, 'message') ?? dotPath(payload, 'data.task_status_msg')
    throw new VideoGenError(`可灵 API 错误 (code ${code}): ${typeof message === 'string' ? message : JSON.stringify(payload).slice(0, 300)}`, 'video-api-error')
  }
  const taskId = firstPath(payload, ['data.task_id', 'task_id'])
  if (taskId === undefined) throw new VideoGenError('可灵 API 未返回 task_id', 'video-no-task')
  return {
    ref: {
      kind: isI2V ? 'kling-i2v' : 'kling-t2v',
      taskId,
      pollUrl: `${base}/v1/videos/${isI2V ? 'image2video' : 'text2video'}/${encodeURIComponent(taskId)}`,
      pollMethod: 'GET',
      statusPath: 'data.task_status',
      doneValues: 'succeed,success',
      failValues: 'failed,cancelled',
      resultUrlPath: 'data.task_result.videos[0].url,data.task_result.videos[1].url,data.task_result.video.url',
    },
    immediate: [],
  }
}

async function queryKling(channel: VideoChannel, ref: TaskRef, signal?: AbortSignal): Promise<RawTaskState> {
  const payload = await fetchJson(ref.pollUrl ?? '', { method: 'GET', headers: { authorization: klingAuth(channel) }, signal })
  const code = Number(dotPath(payload, 'code') ?? 0)
  if (code !== 0) {
    const message = dotPath(payload, 'message') ?? dotPath(payload, 'data.task_status_msg')
    return failed(typeof message === 'string' ? message : `可灵 API 错误 (code ${code})`)
  }
  const status = String(dotPath(payload, ref.statusPath ?? 'data.task_status') ?? '').toLowerCase()
  if (ref.failValues !== undefined && ref.failValues.split(',').map(s => s.trim().toLowerCase()).includes(status)) {
    const msg = dotPath(payload, 'data.task_status_msg')
    return failed(typeof msg === 'string' && msg !== '' ? msg : `可灵任务失败 (${status})`)
  }
  if (ref.doneValues !== undefined && ref.doneValues.split(',').map(s => s.trim().toLowerCase()).includes(status)) {
    const urls = completionUrls(payload, (ref.resultUrlPath ?? 'data.task_result.videos[0].url,data.task_result.videos[1].url,data.task_result.video.url').split(',').map(s => s.trim()).filter(s => s !== ''))
    if (urls.length === 0) return { status: 'processing', videos: [] }
    return completed(urls)
  }
  return status === 'submitted' || status === '' ? { status: 'submitted', videos: [] } : inProgress()
}

/* ------------------------------------------------------------------ */
/*  MiniMax (Hailuo)                                                   */
/* ------------------------------------------------------------------ */

async function submitMiniMax(channel: VideoChannel, request: GenerateVideoRequest, signal?: AbortSignal): Promise<{ ref: TaskRef | undefined; immediate: string[] }> {
  const base = apiRoot(channel.apiUrl)
  const isI2V = request.mode === 'image2video'
  const endpoint = `${base}/${isI2V ? 'image_to_video/v1' : 'video_generation/v1'}`
  const body: Record<string, unknown> = {
    model: channelModel(channel, request.model) ?? 'video-01',
    prompt: request.prompt,
  }
  if (isI2V) body.image_url = request.image ?? ''
  if (request.negativePrompt !== undefined && request.negativePrompt !== '') body.negative_prompt = request.negativePrompt
  if (request.aspectRatio !== undefined && request.aspectRatio !== '') body.aspect_ratio = request.aspectRatio
  if (request.duration !== undefined) body.duration = request.duration
  if (request.resolution !== undefined && request.resolution !== '') body.resolution = request.resolution
  const payload = await fetchJson(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: bearer(channel), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const statusCode = Number(dotPath(payload, 'base_resp.status_code') ?? 0)
  if (statusCode !== 0) {
    const message = dotPath(payload, 'base_resp.status_msg')
    throw new VideoGenError(`MiniMax API 错误 (${statusCode}): ${typeof message === 'string' ? message : JSON.stringify(payload).slice(0, 300)}`, 'video-api-error')
  }
  const taskId = firstPath(payload, ['task_id', 'data.task_id'])
  if (taskId === undefined) throw new VideoGenError('MiniMax API 未返回 task_id', 'video-no-task')
  return {
    ref: {
      kind: isI2V ? 'minimax-i2v' : 'minimax-t2v',
      taskId,
      pollUrl: `${base}/${isI2V ? 'image_to_video/v1' : 'video_generation/v1'}/${encodeURIComponent(taskId)}`,
      pollMethod: 'GET',
      statusPath: 'status',
      doneValues: 'completed,success,successful',
      failValues: 'failed,cancelled,error',
      resultUrlPath: 'data.file_id,file_id',
      fileRetrievePath: 'file_id',
    },
    immediate: [],
  }
}

async function queryMiniMax(channel: VideoChannel, ref: TaskRef, signal?: AbortSignal): Promise<RawTaskState> {
  const payload = await fetchJson(ref.pollUrl ?? '', { method: ref.pollMethod === 'POST' ? 'POST' : 'GET', headers: { authorization: bearer(channel) }, signal })
  const statusCode = Number(dotPath(payload, 'base_resp.status_code') ?? 0)
  if (statusCode !== 0) {
    const message = dotPath(payload, 'base_resp.status_msg')
    return failed(typeof message === 'string' ? message : `MiniMax 任务错误 (${statusCode})`)
  }
  const status = String(dotPath(payload, ref.statusPath ?? 'status') ?? '').toLowerCase()
  if (ref.failValues !== undefined && ref.failValues.split(',').map(s => s.trim().toLowerCase()).includes(status)) {
    const message = dotPath(payload, 'base_resp.status_msg')
    return failed(typeof message === 'string' && message !== '' ? message : `MiniMax 任务失败 (${status})`)
  }
  const done = ref.doneValues !== undefined && ref.doneValues.split(',').map(s => s.trim().toLowerCase()).includes(status)
  if (!done) return status === '' || status === 'pending' ? { status: 'submitted', videos: [] } : inProgress()
  // MiniMax: poll gives a file_id; retrieve a temporary download URL next.
  const fileId = firstPath(payload, [ref.fileRetrievePath ?? 'file_id', 'data.file_id'])
  if (fileId === undefined) {
    const urls = completionUrls(payload, (ref.resultUrlPath ?? '').split(',').map(s => s.trim()).filter(s => s !== ''))
    if (urls.length > 0) return completed(urls)
    return failed('MiniMax 任务完成但未返回 file_id')
  }
  const file = await fetchJson(`${apiRoot(channel.apiUrl)}/files/retrieve/${encodeURIComponent(fileId)}`, {
    method: 'GET',
    headers: { authorization: bearer(channel) },
    signal,
  })
  const url = firstPath(file, ['file.download_url', 'download_url', 'data.download_url'])
  if (url === undefined) return failed('MiniMax 文件检索未返回下载地址')
  return completed([url])
}

/* ------------------------------------------------------------------ */
/*  Custom generic async channel                                       */
/* ------------------------------------------------------------------ */

function customSpecOrFail(channel: VideoChannel): NonNullable<VideoChannel['custom']> {
  const spec = channel.custom
  if (spec === undefined || spec.submitUrl.trim() === '') {
    throw new VideoGenError('自定义渠道缺少 submitUrl 配置', 'video-custom-config')
  }
  return spec
}

async function submitCustom(channel: VideoChannel, request: GenerateVideoRequest, signal?: AbortSignal): Promise<{ ref: TaskRef | undefined; immediate: string[] }> {
  const spec = customSpecOrFail(channel)
  const base = apiRoot(channel.apiUrl)
  const values = placeholderValues(request, base)
  const url = substituteTemplate(spec.submitUrl, values)
  const bodyUnparsed = spec.bodyTemplate ?? '{"model":"{{model}}","prompt":"{{prompt}}"}'
  let body: unknown = {}
  const rendered = substituteTemplate(bodyUnparsed, values)
  try {
    body = JSON.parse(rendered) as unknown
  } catch {
    throw new VideoGenError('自定义渠道 bodyTemplate 不是合法 JSON（请检查模板与占位符）', 'video-custom-config')
  }
  const headerName = spec.apiKeyHeader ?? 'Authorization'
  const scheme = spec.apiKeyScheme ?? 'Bearer'
  const value = scheme === '' ? channel.apiKey.trim() : `${scheme} ${channel.apiKey.trim()}`
  const payload = await fetchJson(url, {
    method: 'POST',
    redirect: 'error',
    headers: { [headerName]: value, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const immediate = completionUrls(payload, splitPaths(spec.resultUrlPath ?? 'data.video_url,data.url,url,video_url'))
  const taskId = firstPath(payload, [spec.taskIdPath ?? 'task_id', 'task_id', 'id'])
  if (immediate.length > 0 && taskId === undefined) return { ref: undefined, immediate }
  if (taskId === undefined) throw new VideoGenError('自定义渠道未返回任务 id 且无同步结果 URL', 'video-no-task')
  return {
    ref: {
      kind: 'custom',
      taskId,
      pollUrl: substituteTemplate(spec.pollUrlTemplate ?? '{{base}}/task/{{taskId}}', { ...values, taskId }),
      pollMethod: (spec.pollMethod ?? 'GET').toUpperCase(),
      statusPath: spec.statusPath ?? 'status',
      doneValues: spec.doneValues ?? 'completed,succeeded,success',
      failValues: spec.failValues ?? 'failed,error,cancelled',
      resultUrlPath: spec.resultUrlPath ?? 'data.video_url,data.url,url,video_url',
    },
    immediate: [],
  }
}

function splitPaths(raw: string): string[] {
  return raw.split(',').map(path => path.trim()).filter(path => path !== '')
}

function placeholderValues(request: GenerateVideoRequest, base: string): Record<string, string> {
  return {
    base,
    prompt: request.prompt,
    model: request.model ?? '',
    image: request.image ?? '',
    negative_prompt: request.negativePrompt ?? '',
    duration: request.duration !== undefined ? String(request.duration) : '',
    aspect_ratio: request.aspectRatio ?? '',
    resolution: request.resolution ?? '',
    seed: request.seed !== undefined ? String(request.seed) : '',
    taskId: '',
  }
}

async function queryCustom(channel: VideoChannel, ref: TaskRef, signal?: AbortSignal): Promise<RawTaskState> {
  const spec = customSpecOrFail(channel)
  const headerName = spec.apiKeyHeader ?? 'Authorization'
  const scheme = spec.apiKeyScheme ?? 'Bearer'
  const value = scheme === '' ? channel.apiKey.trim() : `${scheme} ${channel.apiKey.trim()}`
  const payload = await fetchJson(ref.pollUrl ?? '', {
    method: ref.pollMethod === 'POST' ? 'POST' : 'GET',
    headers: { [headerName]: value },
    signal,
  })
  const status = String(dotPath(payload, ref.statusPath ?? 'status') ?? '').toLowerCase()
  const doneValues = splitPaths(ref.doneValues ?? 'completed,succeeded,success').map(s => s.toLowerCase())
  const failValues = splitPaths(ref.failValues ?? 'failed,error,cancelled').map(s => s.toLowerCase())
  if (failValues.includes(status)) {
    const error = typeof dotPath(payload, 'error.message') === 'string'
      ? String(dotPath(payload, 'error.message'))
      : typeof dotPath(payload, 'error') === 'string' ? String(dotPath(payload, 'error')) : typeof dotPath(payload, 'message') === 'string' ? String(dotPath(payload, 'message')) : undefined
    return failed(error ?? `自定义渠道任务失败 (${status})`)
  }
  if (doneValues.includes(status)) {
    const urls = completionUrls(payload, splitPaths(ref.resultUrlPath ?? 'data.video_url,data.url,url,video_url'))
    if (urls.length === 0) return { status: 'processing', videos: [] }
    return completed(urls)
  }
  if (status === '') {
    const urls = completionUrls(payload, splitPaths(ref.resultUrlPath ?? 'data.video_url,data.url,url,video_url'))
    if (urls.length > 0) return completed(urls)
    return inProgress()
  }
  return status === 'queued' || status === 'pending' || status === 'submitted' ? { status: 'submitted', videos: [] } : inProgress()
}

/* ------------------------------------------------------------------ */
/*  dispatch                                                           */
/* ------------------------------------------------------------------ */

export interface SubmitOutcome {
  ref: TaskRef | undefined
  /** Synchronously returned ready URLs (some gateways answer inline). */
  immediate: string[]
}

/** Submit a generation request to the channel's upstream. */
export async function submitVideoTask(channel: VideoChannel, request: GenerateVideoRequest, signal?: AbortSignal): Promise<SubmitOutcome> {
  if (isPreset(channel, 'kling')) return submitKling(channel, request, signal)
  if (isPreset(channel, 'minimax')) return submitMiniMax(channel, request, signal)
  if (isPreset(channel, 'ark') || channel.preset === 'custom') return submitCustom(channel, request, signal)
  return submitOpenAI(channel, request, signal)
}

/** Query one task's current state. */
export async function queryVideoTask(channel: VideoChannel, ref: TaskRef, signal?: AbortSignal): Promise<{ status: TaskStatus; videos?: string[]; error?: string }> {
  const raw = await (isPreset(channel, 'kling')
    ? queryKling(channel, ref, signal)
    : isPreset(channel, 'minimax')
      ? queryMiniMax(channel, ref, signal)
      : ref.kind === 'custom'
        ? queryCustom(channel, ref, signal)
        : queryOpenAI(channel, ref, signal))
  return { status: raw.status, ...(raw.videos.length > 0 ? { videos: raw.videos } : {}), ...(raw.error !== undefined ? { error: raw.error } : {}) }
}

/** Poll until completion (or failure / deadline). Returns a stop reason. */
export async function waitForTask(
  channel: VideoChannel,
  ref: TaskRef,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<{ status: TaskStatus; videos?: string[]; error?: string }> {
  const startedAt = Date.now()
  const interval = options.intervalMs ?? 5_000
  let last: { status: TaskStatus; videos?: string[]; error?: string } = { status: 'submitted' }
  while (Date.now() - startedAt < options.timeoutMs) {
    last = await queryVideoTask(channel, ref, options.signal)
    if (last.status === 'completed' || last.status === 'failed') return last
    await sleep(Math.min(interval, options.timeoutMs - (Date.now() - startedAt)), options.signal)
  }
  return { status: last.status === 'completed' || last.status === 'failed' ? last.status : 'processing', ...(last.videos !== undefined ? { videos: last.videos } : {}), ...(last.error !== undefined ? { error: last.error } : {}) }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, Math.max(0, ms))
    timer.unref?.()
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** Fetch a video URL into memory (bounded). */
export async function fetchVideo(url: string, apiKey = '', signal?: AbortSignal): Promise<{ data: Uint8Array; mime: string }> {
  const budget = requestSignal(signal, VIDEO_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
      redirect: 'follow',
      signal: budget.signal,
    })
    if (!response.ok) throw new VideoGenError(`下载生成视频失败: HTTP ${response.status}`, 'video-download-failed')
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const data = new Uint8Array(await response.arrayBuffer())
    return { data, mime: mime === '' ? videoMimeFromUrl(url) : mime }
  } finally {
    budget.dispose()
  }
}

function videoMimeFromUrl(url: string): string {
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.mov')) return 'video/quicktime'
  if (path.endsWith('.gif')) return 'image/gif'
  return inferVideoMime(url)
}

/** Detect a few common video containers from magic bytes. */
export function detectVideoMime(data: Uint8Array): string | undefined {
  if (data.length >= 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return 'video/mp4'
  if (data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return 'video/webm'
  if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x18) return 'video/mp4'
  if (data.length >= 4 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return 'video/avi'
  return undefined
}

function inferVideoMime(url: string): string {
  const path = url.split('?')[0]?.toLowerCase() ?? ''
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.mov')) return 'video/quicktime'
  if (path.endsWith('.avi')) return 'video/avi'
  return 'video/mp4'
}
