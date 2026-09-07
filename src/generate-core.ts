/**
 * Generation core: submit → poll → persist, shared by the panel routes and
 * the Agent tools so a video task is recorded exactly once.
 */

import { randomUUID } from 'node:crypto'
import { submitVideoTask, queryVideoTask, waitForTask, fetchVideo, VideoGenError, type VideoChannel } from './video-engine.ts'
import { saveVideoFile, upsertHistory, upsertTask, removeTask, findTask, importToLibrary, readDataFile, listHistory } from './video-store.ts'
import type { GenerateResult, GenerateVideoRequest, HistoryEntry, GeneratedVideo, TaskRef } from './protocol.ts'
import { ASSETS_API } from './protocol.ts'

const DEFAULT_WAIT_SECONDS = 240

export function parseGenerateRequest(body: Record<string, unknown>): GenerateVideoRequest | undefined {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') return undefined
  const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const flag = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
  return {
    mode: body.mode === 'image2video' ? 'image2video' : 'text2video',
    ...(str(body.channelId) !== undefined ? { channelId: str(body.channelId) } : {}),
    ...(str(body.model) !== undefined ? { model: str(body.model) } : {}),
    prompt,
    ...(str(body.image) !== undefined ? { image: str(body.image) } : {}),
    ...(str(body.negativePrompt) !== undefined ? { negativePrompt: str(body.negativePrompt) } : {}),
    ...(str(body.aspectRatio) !== undefined ? { aspectRatio: str(body.aspectRatio) } : {}),
    ...(num(body.duration) !== undefined ? { duration: num(body.duration) } : {}),
    ...(str(body.resolution) !== undefined ? { resolution: str(body.resolution) } : {}),
    ...(num(body.seed) !== undefined ? { seed: num(body.seed) } : {}),
    ...(flag(body.enhancePrompt) !== undefined ? { enhancePrompt: flag(body.enhancePrompt) } : {}),
    ...(flag(body.saveToLibrary) !== undefined ? { saveToLibrary: flag(body.saveToLibrary) } : {}),
    ...(flag(body.wait) !== undefined ? { wait: flag(body.wait) } : {}),
    ...(num(body.waitSeconds) !== undefined ? { waitSeconds: num(body.waitSeconds) } : {}),
  }
}

export interface GenerateRunOptions {
  channel: VideoChannel
  request: GenerateVideoRequest
  /** Wait for completion inside this call (default true for the panel). */
  wait: boolean
  /** Max wait seconds (default 240, capped at 900). */
  waitSeconds?: number
  autoSave: () => boolean
  signal?: AbortSignal
}

function historyUrl(file: string): string {
  return `${ASSETS_API}/videos/${file}`
}

/** Download raw upstream URLs into same-origin assets; fall back to remote. */
export async function persistVideos(channel: VideoChannel, rawUrls: string[], signal?: AbortSignal): Promise<GeneratedVideo[]> {
  const out: GeneratedVideo[] = []
  for (const raw of rawUrls) {
    try {
      const fetched = await fetchVideo(raw, channel.apiKey, signal)
      const saved = await saveVideoFile(fetched.data, fetched.mime)
      out.push({ url: historyUrl(saved.file), remoteUrl: raw, file: saved.file, mime: fetched.mime, bytes: saved.bytes })
    } catch {
      // Upstream URL may be signed or slow; keep it as the playable URL.
      out.push({ url: raw, remoteUrl: raw })
    }
  }
  return out
}

/** Submit + optionally wait; persists task registry and history. */
export async function runGeneration(options: GenerateRunOptions): Promise<GenerateResult> {
  const { channel, request } = options
  const wait = options.wait !== false
  const waitSeconds = Math.min(Math.max(Math.round(options.waitSeconds ?? DEFAULT_WAIT_SECONDS), 5), 900)
  const historyId = randomUUID()
  const entryBase: Omit<HistoryEntry, 'id' | 'createdAt' | 'status' | 'videos'> & { id: string; createdAt: number } = {
    id: historyId,
    taskId: '',
    channelId: channel.id,
    channel: channel.name,
    ...(request.model !== undefined ? { model: request.model } : {}),
    mode: request.mode,
    prompt: request.prompt,
    ...(request.image !== undefined ? { image: request.image } : {}),
    ...(request.negativePrompt !== undefined ? { negativePrompt: request.negativePrompt } : {}),
    ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    params: { wait },
    createdAt: Date.now(),
  }

  const submitted = await submitVideoTask(channel, request, options.signal)
  if (submitted.ref === undefined) {
    // Synchronous answer — some gateways return the video immediately.
    const videos = await persistVideos(channel, submitted.immediate, options.signal)
    const entry: HistoryEntry = { ...entryBase, taskId: '', status: 'completed', videos }
    await upsertHistory(entry)
    maybeArchive(entry, options)
    return { status: 'completed', videos, channelId: channel.id, model: request.model, prompt: request.prompt }
  }
  const ref = submitted.ref
  const entry: HistoryEntry = { ...entryBase, taskId: ref.taskId, taskRef: ref, status: 'submitted', videos: [] }
  await upsertHistory(entry)
  await upsertTask({
    taskId: ref.taskId,
    channelId: channel.id,
    channel: channel.name,
    ...(request.model !== undefined ? { model: request.model } : {}),
    mode: request.mode,
    prompt: request.prompt,
    ...(request.image !== undefined ? { image: request.image } : {}),
    ref,
    createdAt: Date.now(),
  })

  if (!wait) {
    return { status: refTaskStatus(ref), taskId: ref.taskId, videos: [], channelId: channel.id, model: request.model, prompt: request.prompt }
  }

  const outcome = await waitForTask(channel, ref, { timeoutMs: waitSeconds * 1000, signal: options.signal })
  await removeTask(ref.taskId)
  if (outcome.status === 'completed' && outcome.videos !== undefined && outcome.videos.length > 0) {
    const videos = await persistVideos(channel, outcome.videos, options.signal)
    const updated: HistoryEntry = { ...entry, status: 'completed', videos, error: undefined }
    await upsertHistory(updated)
    maybeArchive(updated, options)
    return { status: 'completed', taskId: ref.taskId, videos, channelId: channel.id, model: request.model, prompt: request.prompt }
  }
  if (outcome.status === 'failed') {
    const updated: HistoryEntry = { ...entry, status: 'failed', error: outcome.error }
    await upsertHistory(updated)
    return { status: 'failed', taskId: ref.taskId, videos: [], error: outcome.error, channelId: channel.id, model: request.model, prompt: request.prompt }
  }
  // Timed out while processing — keep the registry for a later query.
  const inFlight: HistoryEntry = { ...entry, status: 'processing', videos: [] }
  await upsertHistory(inFlight)
  return { status: 'processing', taskId: ref.taskId, videos: [], channelId: channel.id, model: request.model, prompt: request.prompt }
}

function refTaskStatus(ref: TaskRef): 'submitted' {
  return 'submitted'
}

async function maybeArchive(entry: HistoryEntry, options: GenerateRunOptions): Promise<void> {
  if (!options.autoSave()) return
  const videos = entry.videos.filter(video => video.file !== undefined && video.file !== '')
  for (const video of videos) {
    await importToLibrary({
      type: 'video',
      name: `${(entry.prompt ?? '生成视频').slice(0, 48)}`,
      sourceFile: video.file!,
      url: video.url,
      provenance: {
        channelId: entry.channelId,
        channel: entry.channel,
        model: entry.model,
        mode: entry.mode,
        prompt: entry.prompt,
        params: entry.params,
        createdAt: entry.createdAt,
      },
    })
  }
}

/** Query a previously submitted task; downloads and archives on completion. */
export async function queryGeneration(channel: VideoChannel, taskId: string, options: { signal?: AbortSignal }): Promise<GenerateResult> {
  // Prefer the in-flight registry; fall back to history for restarts.
  const record = await findTask(taskId)
  const historyEntries = await listHistory()
  const historyEntry = historyEntries.find(entry => entry.taskId === taskId)
  const ref: TaskRef | undefined = record?.ref ?? historyEntry?.taskRef
  if (ref === undefined) {
    throw new VideoGenError(`找不到任务 ${taskId}（任务未在本机登记）`, 'video-task-unknown')
  }
  const outcome = await queryVideoTask(channel, ref, options.signal)
  const base = historyEntry ?? {
    id: randomUUID(),
    taskId,
    channelId: channel.id,
    channel: channel.name,
    mode: 'text2video' as const,
    prompt: record?.prompt ?? '',
    status: 'submitted' as const,
    videos: [],
    createdAt: record?.createdAt ?? Date.now(),
  }
  await removeTask(taskId)
  if (outcome.status === 'completed' && outcome.videos !== undefined && outcome.videos.length > 0) {
    const videos = (await persistVideos(channel, outcome.videos, options.signal)).map(video => ({
      url: video.url,
      ...(video.remoteUrl !== undefined ? { remoteUrl: video.remoteUrl } : {}),
      ...(video.file !== undefined ? { file: video.file } : {}),
      ...(video.mime !== undefined ? { mime: video.mime } : {}),
      ...(video.bytes !== undefined ? { bytes: video.bytes } : {}),
      ...(video.duration !== undefined ? { duration: video.duration } : {}),
      ...(video.width !== undefined ? { width: video.width } : {}),
      ...(video.height !== undefined ? { height: video.height } : {}),
    }))
    const updated: HistoryEntry = { ...base, taskId, status: 'completed', videos, error: undefined }
    await upsertHistory(updated)
    return { status: 'completed', taskId, videos: updated.videos, channelId: channel.id, model: updated.model, prompt: updated.prompt }
  }
  if (outcome.status === 'failed') {
    const updated: HistoryEntry = { ...base, taskId, status: 'failed', error: outcome.error }
    await upsertHistory(updated)
    return { status: 'failed', taskId, videos: [], error: outcome.error, channelId: channel.id, model: updated.model, prompt: updated.prompt }
  }
  if (historyEntry?.status === 'completed' && historyEntry.videos.length > 0) {
    return { status: 'completed', taskId, videos: historyEntry.videos, channelId: channel.id, model: historyEntry.model, prompt: historyEntry.prompt }
  }
  const updated: HistoryEntry = { ...base, taskId, status: outcome.status === 'submitted' ? 'submitted' : 'processing', videos: [] }
  await upsertHistory(updated)
  return { status: updated.status, taskId, videos: [], channelId: channel.id, model: updated.model, prompt: updated.prompt }
}

/** Mark a task cancelled locally (keeps history). */
export async function cancelGeneration(taskId: string): Promise<GenerateResult> {
  const record = await findTask(taskId)
  await removeTask(taskId)
  const historyEntry = (await listHistory()).find(entry => entry.taskId === taskId)
  if (historyEntry !== undefined) {
    const updated: HistoryEntry = { ...historyEntry, status: 'failed', error: '已取消（本地）' }
    await upsertHistory(updated)
  }
  return {
    status: 'failed',
    taskId,
    videos: [],
    error: '已取消（本地）',
    channelId: record?.channelId,
    model: record?.model,
    prompt: record?.prompt,
  }
}

/** Resolve an asset URL back to local data (for the same-origin route). */
export async function readAsset(kind: 'videos' | 'output' | 'library', file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  return readDataFile(kind, file)
}
