/**
 * Host-side persistence for dsh-videogen: generated videos, processing
 * outputs, generation history, in-flight task registry, storyboard
 * projects and the resource library. All droppable under
 * ~/.dsh/dsh-videogen/.
 */

import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { HistoryEntry, LibraryEntry, LibraryType, StoryboardProject, TaskRef } from './protocol.ts'
import { HISTORY_MAX } from './protocol.ts'

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Root data dir for this plugin. */
export const VIDEO_DATA_DIR = path.join(dshHome(), 'dsh-videogen')

/** Raw generated videos (before library normalization). */
export const VIDEO_AUDIO_DIR = path.join(VIDEO_DATA_DIR, 'videos')

/** Processing outputs (frames / gifs / compresses / con cats). */
export const PROCESS_OUTPUT_DIR = path.join(VIDEO_DATA_DIR, 'output')

/** Library media files. */
export const LIBRARY_DATA_DIR = path.join(VIDEO_DATA_DIR, 'library')

/** Storyboard project files (one JSON per project). */
export const STUDIO_PROJECTS_DIR = path.join(VIDEO_DATA_DIR, 'projects')

const HISTORY_FILE = path.join(VIDEO_DATA_DIR, 'history.json')
const TASKS_FILE = path.join(VIDEO_DATA_DIR, 'tasks.json')
const LIBRARY_INDEX_FILE = path.join(LIBRARY_DATA_DIR, 'index.json')

async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/* ------------------------------------------------------------------ */
/*  video files                                                        */
/* ------------------------------------------------------------------ */

export interface SavedVideo {
  id: string
  file: string
  mime: string
  bytes: number
}

/** Persist one video byte payload under the asset dir. */
export async function saveVideoFile(data: Uint8Array, mime: string, extHint?: string): Promise<SavedVideo> {
  await ensureDir(VIDEO_AUDIO_DIR)
  const id = randomUUID()
  const extension = videoExtension(mime, extHint)
  const file = `${id}.${extension}`
  await writeFile(path.join(VIDEO_AUDIO_DIR, file), data)
  return { id, file, mime, bytes: data.byteLength }
}

export function videoExtension(mime: string, extHint?: string): string {
  if (extHint !== undefined && extHint.trim() !== '') {
    const ext = extHint.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (ext !== '') return ext
  }
  const type = mime.split('/')[1]?.toLowerCase() ?? ''
  switch (type) {
    case 'mp4': return 'mp4'
    case 'webm': return 'webm'
    case 'quicktime': return 'mov'
    case 'gif': return 'gif'
    case 'jpeg': return 'jpg'
    case 'png': return 'png'
    default: return 'mp4'
  }
}

/** Read a file from one of the plugin data dirs by relative name. */
export async function readDataFile(kind: 'videos' | 'output' | 'library', file: string): Promise<{ data: Buffer; mime: string } | undefined> {
  const safe = safeName(file)
  const dir = kind === 'videos' ? VIDEO_AUDIO_DIR : kind === 'output' ? PROCESS_OUTPUT_DIR : LIBRARY_DATA_DIR
  const full = path.join(dir, safe)
  if (!full.startsWith(dir)) return undefined
  try {
    const data = await readFile(full)
    return { data, mime: mimeFromFile(safe) }
  } catch {
    return undefined
  }
}

function mimeFromFile(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    case '.avi': return 'video/avi'
    case '.gif': return 'image/gif'
    case '.jpg': case '.jpeg': return 'image/jpeg'
    case '.png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

/** Server-side resolve of a same-origin asset URL to a local file path. */
const ASSET_PREFIX = '/api/dsh-videogen/assets/'

export function resolveAssetPath(url: string): string | undefined {
  if (!url.startsWith(ASSET_PREFIX)) return undefined
  const rest = url.slice(ASSET_PREFIX.length)
  const parts = rest.split('/')
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return undefined
  const kind = parts[0]
  const file = parts[1]
  const dir = kind === 'videos' ? VIDEO_AUDIO_DIR : kind === 'output' ? PROCESS_OUTPUT_DIR : kind === 'library' ? LIBRARY_DATA_DIR : undefined
  if (dir === undefined) return undefined
  const full = path.join(dir, safeName(file))
  return existsSync(full) ? full : undefined
}

/** Persist an uploaded browser file (base64 body) under the output dir. */
export async function saveUpload(data: Uint8Array, name: string): Promise<SavedOutput> {
  await ensureDir(PROCESS_OUTPUT_DIR)
  const ext = path.extname(name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin'
  const id = randomUUID()
  const file = `upload_${id}.${ext}`
  await writeFile(path.join(PROCESS_OUTPUT_DIR, file), data)
  return { file, mime: mimeFromFile(file), bytes: data.byteLength }
}

/* ------------------------------------------------------------------ */
/*  processing outputs                                                 */
/* ------------------------------------------------------------------ */

export interface SavedOutput {
  file: string
  mime: string
  bytes: number
}

/** Persist a processing output (frame jpg / gif / compressed image / concat video). */
export async function saveProcessOutput(data: Uint8Array, ext: string): Promise<SavedOutput> {
  await ensureDir(PROCESS_OUTPUT_DIR)
  const id = randomUUID()
  const file = `${id}.${ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin'}`
  await writeFile(path.join(PROCESS_OUTPUT_DIR, file), data)
  return { file, mime: mimeFromFile(file), bytes: data.byteLength }
}

/** Path (absolute) where a given output file name would live. */
export function processOutputPath(file: string): string {
  const safe = safeName(file)
  return path.join(PROCESS_OUTPUT_DIR, safe)
}

export async function writeProcessOutputFile(name: string, data: Uint8Array): Promise<string> {
  await ensureDir(PROCESS_OUTPUT_DIR)
  const safe = safeName(name)
  const full = path.join(PROCESS_OUTPUT_DIR, safe)
  await writeFile(full, data)
  return safe
}

/* ------------------------------------------------------------------ */
/*  history                                                            */
/* ------------------------------------------------------------------ */

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return parsed as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function listHistory(): Promise<HistoryEntry[]> {
  return readJson<HistoryEntry[]>(HISTORY_FILE, [])
}

/** Append or update a history entry by id; enforces the cap. */
export async function upsertHistory(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const list = await listHistory()
  const index = list.findIndex(item => item.id === entry.id)
  const next = [...list]
  if (index >= 0) next[index] = { ...entry }
  else next.unshift(entry)
  await writeJson(HISTORY_FILE, next.slice(0, HISTORY_MAX))
  return next.slice(0, HISTORY_MAX)
}

export async function removeHistory(id: string): Promise<HistoryEntry[]> {
  const list = await listHistory()
  const next = list.filter(item => item.id !== id)
  await writeJson(HISTORY_FILE, next)
  return next
}

export async function clearHistory(): Promise<void> {
  await writeJson(HISTORY_FILE, [])
}

/* ------------------------------------------------------------------ */
/*  task registry                                                      */
/* ------------------------------------------------------------------ */

interface TaskRecord {
  taskId: string
  channelId: string
  channel: string
  model?: string
  mode: HistoryEntry['mode']
  prompt: string
  image?: string
  ref: TaskRef
  createdAt: number
}

export async function listTasks(): Promise<TaskRecord[]> {
  return readJson<TaskRecord[]>(TASKS_FILE, [])
}

export async function upsertTask(record: TaskRecord): Promise<void> {
  const list = await listTasks()
  const index = list.findIndex(item => item.taskId === record.taskId)
  const next = [...list]
  if (index >= 0) next[index] = record
  else next.unshift(record)
  await writeJson(TASKS_FILE, next.slice(0, 500))
}

export async function removeTask(taskId: string): Promise<void> {
  const list = await listTasks()
  await writeJson(TASKS_FILE, list.filter(item => item.taskId !== taskId))
}

export async function findTask(taskId: string): Promise<TaskRecord | undefined> {
  const list = await listTasks()
  return list.find(item => item.taskId === taskId)
}

/* ------------------------------------------------------------------ */
/*  library                                                            */
/* ------------------------------------------------------------------ */

export async function listLibrary(): Promise<LibraryEntry[]> {
  return readJson<LibraryEntry[]>(LIBRARY_INDEX_FILE, [])
}

export async function upsertLibrary(entry: LibraryEntry): Promise<LibraryEntry[]> {
  const list = await listLibrary()
  const index = list.findIndex(item => item.id === entry.id)
  const next = [...list]
  if (index >= 0) next[index] = entry
  else next.unshift(entry)
  await writeJson(LIBRARY_INDEX_FILE, next.slice(0, 1000))
  return next.slice(0, 1000)
}

export async function removeLibrary(id: string): Promise<LibraryEntry[]> {
  const list = await listLibrary()
  const entry = list.find(item => item.id === id)
  const next = list.filter(item => item.id !== id)
  await writeJson(LIBRARY_INDEX_FILE, next)
  if (entry?.type === 'storyboard') {
    // storyboard entries reference project files; leave the file.
  } else if (entry?.file !== undefined && entry.file !== '') {
    const full = path.join(LIBRARY_DATA_DIR, safeName(entry.file))
    try { await unlink(full) } catch { /* file may be gone already */ }
  }
  return next
}

/** Import a generated video into the library (moves the file). */
export async function importToLibrary(input: {
  type: LibraryType
  name: string
  tags?: string[]
  category?: string
  sourceFile: string
  url?: string
  provenance: LibraryEntry['provenance']
}): Promise<{ entry: LibraryEntry; file: string }> {
  await ensureDir(LIBRARY_DATA_DIR)
  const id = randomUUID()
  const extension = path.extname(input.sourceFile).toLowerCase()
  const file = `${id}${extension}`
  await rename(path.join(VIDEO_DATA_DIR, input.sourceFile), path.join(LIBRARY_DATA_DIR, file))
  const entry: LibraryEntry = {
    id,
    type: input.type,
    name: input.name,
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.category !== undefined && input.category !== '' ? { category: input.category } : {}),
    file,
    ...(input.url !== undefined ? { url: input.url } : {}),
    provenance: input.provenance,
    createdAt: Date.now(),
  }
  await upsertLibrary(entry)
  return { entry, file }
}

/** Persist a storyboard project. */
export async function saveProject(project: StoryboardProject): Promise<void> {
  await ensureDir(STUDIO_PROJECTS_DIR)
  await writeJson(path.join(STUDIO_PROJECTS_DIR, `${safeName(project.id)}.json`), project)
}

export async function loadProject(id: string): Promise<StoryboardProject | undefined> {
  return readJson<StoryboardProject | undefined>(path.join(STUDIO_PROJECTS_DIR, `${safeName(id)}.json`), undefined)
}

export async function listProjects(): Promise<StoryboardProject[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const files = (await readdir(STUDIO_PROJECTS_DIR)).filter(file => file.endsWith('.json'))
    const projects: StoryboardProject[] = []
    for (const file of files) {
      const project = await readJson<StoryboardProject | undefined>(path.join(STUDIO_PROJECTS_DIR, file), undefined)
      if (project !== undefined) projects.push(project)
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function removeProject(id: string): Promise<void> {
  try {
    await unlink(path.join(STUDIO_PROJECTS_DIR, `${safeName(id)}.json`))
  } catch {
    // already gone — fine
  }
}
