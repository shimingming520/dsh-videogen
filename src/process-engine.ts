/**
 * Host-side FFmpeg processing engine.
 *
 * Implements the dsh-video-tools feature set server-side so the Agent can
 * process generated videos (probe, frame extraction, GIF conversion, image
 * compression, concat) directly on URLs or workspace files. The binary is
 * resolved in order: FFMPEG_PATH env → @ffmpeg-installer/ffmpeg → system
 * ffmpeg on PATH → ffmpeg-static. Inputs may be http(s) URLs (ffmpeg reads
 * them directly) or absolute local paths.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProcessResult, VideoInfoResult } from './protocol.ts'

const require = createRequire(import.meta.url)

/** A processing failure with a user-presentable message. */
export class ProcessError extends Error {
  readonly code: string

  constructor(message: string, code = 'video-process-failed') {
    super(message)
    this.name = 'ProcessError'
    this.code = code
  }
}

let cachedFFmpeg: string | undefined
let ffmpegResolved = false

/** Resolve an ffmpeg binary, caching the result. */
export function resolveFFmpeg(): string {
  if (ffmpegResolved) {
    if (cachedFFmpeg !== undefined) return cachedFFmpeg
    throw new ProcessError('未找到 FFmpeg：请安装 ffmpeg（brew install ffmpeg）或设置 FFMPEG_PATH 环境变量', 'ffmpeg-missing')
  }
  const candidates: string[] = []
  if (process.env.FFMPEG_PATH !== undefined && process.env.FFMPEG_PATH.trim() !== '') candidates.push(process.env.FFMPEG_PATH.trim())
  try {
    // @ffmpeg-installer ships a platform binary inside the npm package.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installer = require('@ffmpeg-installer/ffmpeg') as { path?: string }
    if (typeof installer.path === 'string') candidates.push(installer.path)
  } catch {
    // optional — system ffmpeg may still exist
  }
  try {
    // ffmpeg-static may be present on installs with a working download.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const staticPath = require('ffmpeg-static') as string | null
    if (typeof staticPath === 'string' && staticPath !== '') candidates.push(staticPath)
  } catch {
    // optional
  }
  candidates.push('ffmpeg') // PATH lookup last
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (existsSync(candidate)) {
        cachedFFmpeg = candidate
        ffmpegResolved = true
        return candidate
      }
      continue
    }
    cachedFFmpeg = candidate
    ffmpegResolved = true
    return candidate
  }
  throw new ProcessError('未找到 FFmpeg：请安装 ffmpeg（brew install ffmpeg）或设置 FFMPEG_PATH 环境变量', 'ffmpeg-missing')
}

function run(args: string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveFFmpeg()
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        const code = (error as NodeJS.ErrnoException & { code?: string | number }).code
        if (code === 'ETIMEDOUT' || typeof code === 'number' && code === 124) {
          reject(new ProcessError('FFmpeg 处理超时', 'ffmpeg-timeout'))
          return
        }
        const detail = (stderr as string).slice(-1200)
        reject(new ProcessError(`FFmpeg 处理失败${detail === '' ? '' : `: ${detail}`}`))
        return
      }
      resolve({ stdout: stdout as string, stderr: stderr as string })
    })
  })
}

function parseDuration(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const match = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(raw)
  if (match === null) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function parseSize(raw: string | undefined): { width?: number; height?: number } {
  if (raw === undefined) return {}
  const match = /(\d+)x(\d+)/.exec(raw)
  if (match === null) return {}
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** Probe a media file's metadata via `-i` diagnostics. */
export async function probeInfo(input: string): Promise<VideoInfoResult> {
  const { stderr } = await run(['-hide_banner', '-i', input, '-f', 'null', '-'], 120_000)
  const text = `${stderr}\n`
  const info: VideoInfoResult = { raw: text.slice(0, 4000) }
  const duration = parseDuration(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(text)?.[1])
  if (duration !== undefined) info.duration = duration
  const video = /Stream #\d+:\d+(?:\(\w+\))?.*Video:\s*([^,\s]+)[^\n]*\s(\d+)x(\d+)(?:[^\n]*?(\d+(?:\.\d+)?)\s*fps)?/.exec(text)
  if (video !== null) {
    info.videoCodec = video[1]
    info.width = Number(video[2])
    info.height = Number(video[3])
    if (video[4] !== undefined) info.fps = Number(video[4])
  }
  const audio = /Stream #\d+:\d+(?:\(\w+\))?.*Audio:\s*([^,\s]+)/.exec(text)
  if (audio !== null) info.audioCodec = audio[1]
  const size = /size=\s*(\d+)\s*KiB/.exec(text)
  if (size !== null) info.sizeBytes = Number(size[1]) * 1024
  return info
}

/* ------------------------------------------------------------------ */
/*  frame extraction                                                   */
/* ------------------------------------------------------------------ */

export async function extractFrames(input: string, options: {
  count?: number
  at?: number
  width?: number
  quality?: number
  outDir: string
}): Promise<Array<{ file: string; name: string }>> {
  const count = Math.min(Math.max(Math.floor(options.count ?? 1), 1), 20)
  const stem = `frames_${randomUUID().slice(0, 8)}`
  const args: string[] = ['-hide_banner', '-y']
  if (options.at !== undefined && options.at > 0) args.push('-ss', String(options.at))
  if (options.at !== undefined) {
    const out = path.join(options.outDir, `${stem}_at${Math.round(options.at)}.jpg`)
    args.push('-i', input, '-frames:v', '1', '-q:v', String(options.quality ?? 2))
    if (options.width !== undefined && options.width > 0) args.push('-vf', `scale=${options.width}:-2`)
    args.push(out)
    await run(args, 180_000)
    return [{ file: path.basename(out), name: path.basename(out) }]
  }
  // Even spacing: first probe, then sample at count/duration.
  const info = await probeInfo(input)
  const duration = info.duration ?? 1
  const fps = Math.min(Math.max(count / Math.max(duration, 0.1), 0.01), 30)
  const pattern = path.join(options.outDir, `${stem}_%03d.jpg`)
  args.push('-i', input, '-vf', `fps=${fps.toFixed(4)}${options.width !== undefined && options.width > 0 ? `,scale=${options.width}:-2` : ''}`, '-q:v', String(options.quality ?? 2), pattern)
  await run(args, 240_000)
  // Enumerate produced files.
  const { readdir } = await import('node:fs/promises')
  const files = (await readdir(options.outDir)).filter(name => name.startsWith(`${stem}_`) && name.endsWith('.jpg')).sort()
  return files.map(file => ({ file, name: file }))
}

/* ------------------------------------------------------------------ */
/*  GIF                                                                */
/* ------------------------------------------------------------------ */

export async function videoToGif(input: string, options: {
  start?: number
  duration?: number
  width?: number
  fps?: number
  outPath: string
}): Promise<{ ok: true }> {
  const width = Math.min(Math.max(Math.round(options.width ?? 480), 32), 1280)
  const fps = Math.min(Math.max(Math.round(options.fps ?? 10), 1), 30)
  const palette = `${options.outPath}.pal.png`
  const filter = `fps=${fps},scale=${width}:-1:flags=lanczos`
  const inputArgs: string[] = []
  if (options.start !== undefined && options.start > 0) inputArgs.push('-ss', String(options.start))
  if (options.duration !== undefined && options.duration > 0) inputArgs.push('-t', String(options.duration))
  await run(['-hide_banner', '-y', ...inputArgs, '-i', input, '-vf', `${filter},palettegen=max_colors=256`, palette], 300_000)
  await run(['-hide_banner', '-y', ...inputArgs, '-i', input, '-i', palette, '-lavfi', `${filter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, options.outPath], 300_000)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  image compress                                                     */
/* ------------------------------------------------------------------ */

export async function compressImage(input: string, options: {
  width?: number
  quality?: number
  outPath: string
}): Promise<{ ok: true }> {
  const width = Math.min(Math.max(Math.round(options.width ?? 1280), 16), 8192)
  await run(['-hide_banner', '-y', '-i', input, '-vf', `scale=${width}:-2`, '-q:v', String(options.quality ?? 5), options.outPath], 180_000)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  concat / compose                                                   */
/* ------------------------------------------------------------------ */

export interface SegmentInput {
  /** http(s) URL or absolute local path. */
  input: string
  /** Optional per-segment trim in seconds. */
  duration?: number
}

export async function concatSegments(segments: SegmentInput[], options: {
  outPath: string
  width?: number
  height?: number
  transition?: number
  fps?: number
  audioUrl?: string
}): Promise<{ ok: true }> {
  if (segments.length === 0) throw new ProcessError('没有可合成的片段', 'concat-empty')
  if (segments.length === 1 && options.transition === undefined) {
    await run(['-hide_banner', '-y', '-i', segments[0].input, '-c', 'copy', options.outPath], 600_000)
    return { ok: true }
  }
  const tempDir = await impromptuDir()
  const width = options.width ?? 1280
  const height = options.height ?? 720
  const fps = options.fps ?? 30
  const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
  // Stage 1: normalize every segment to a uniform size + fps + duration.
  const normalized: string[] = []
  try {
    for (const segment of segments) {
      const temp = path.join(tempDir, `seg_${normalized.length}.mp4`)
      const args: string[] = ['-hide_banner', '-y', '-i', segment.input]
      if (segment.duration !== undefined && segment.duration > 0) args.push('-t', String(segment.duration))
      args.push('-vf', `${scaleFilter},fps=${fps}`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temp)
      await run(args, 600_000)
      normalized.push(temp)
    }
    // Stage 2: xfade chain (if transition > 0) else concat.
    const transition = Math.min(Math.max(options.transition ?? 0, 0), 2)
    if (normalized.length > 1 && transition > 0) {
      // xfade requires identical input durations: trim every segment to the
      // shortest one, then chain with offsets k*(T - d).
      const probes: VideoInfoResult[] = []
      for (const file of normalized) probes.push(await probeInfo(file))
      const target = Math.max(...probes.map(probe => probe.duration ?? 1), 0.2)
      const trimmed: string[] = []
      for (let index = 0; index < normalized.length; index++) {
        const copy = normalized[index]!
        if (index < normalized.length - 1) {
          const fixedFile = path.join(tempDir, `segfix_${index}.mp4`)
          await run(['-hide_banner', '-y', '-i', copy, '-t', String(target), '-c', 'copy', fixedFile], 600_000)
          trimmed.push(fixedFile)
        } else {
          trimmed.push(copy)
        }
      }
      const unit = Math.max(target - transition, 0.1)
      await run(['-hide_banner', '-y', ...xfadeArgs(trimmed, transition, unit), options.outPath], 900_000)
    } else {
      const listFile = path.join(tempDir, 'concat.txt')
      await writeFile(listFile, normalized.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'))
      await run(['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', options.outPath], 900_000)
    }
    // Stage 3: optional background audio mix.
    if (options.audioUrl !== undefined && options.audioUrl.trim() !== '') {
      const mixed = path.join(tempDir, 'mixed.mp4')
      await run(['-hide_banner', '-y', '-i', options.outPath, '-i', options.audioUrl, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', mixed], 600_000)
      const finalData = await readFile(mixed)
      await writeFile(options.outPath, finalData)
    }
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(tempDir, { recursive: true, force: true }).catch(() => undefined))
  }
  return { ok: true }
}

function xfadeArgs(inputs: string[], transitionSeconds: number, unitSeconds: number): string[] {
  const args: string[] = []
  for (const file of inputs) args.push('-i', file)
  const chains: string[] = []
  let previousLabel = '0:v'
  for (let index = 1; index < inputs.length; index++) {
    const outLabel = `v${index}`
    const offset = index * unitSeconds
    chains.push(`[${previousLabel}][${index}:v]xfade=transition=fade:duration=${transitionSeconds}:offset=${offset.toFixed(3)}[${outLabel}]`)
    previousLabel = outLabel
  }
  const filterComplex = chains.join(';')
  return [...args, '-filter_complex', filterComplex, '-map', `[${previousLabel}]`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
}

async function impromptuDir(): Promise<string> {
  const dir = path.join(tmpdir(), `dsh-videogen-${randomUUID().slice(0, 8)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ */
/*  dispatcher                                                         */
/* ------------------------------------------------------------------ */

/** Run one processing action and save outputs into `outDir`. */
export async function runProcessAction(options: {
  action: 'info' | 'frames' | 'gif' | 'compress' | 'concat'
  input?: string
  inputs?: string[]
  count?: number
  at?: number
  width?: number
  quality?: number
  start?: number
  duration?: number
  fps?: number
  transition?: number
  audioUrl?: string
  outDir: string
}): Promise<ProcessResult> {
  if (options.action === 'info') {
    if (options.input === undefined || options.input === '') throw new ProcessError('info 需要输入文件', 'bad-input')
    const info = await probeInfo(options.input)
    return { info }
  }
  if (options.action === 'frames') {
    if (options.input === undefined || options.input === '') throw new ProcessError('frames 需要输入文件', 'bad-input')
    const frames = await extractFrames(options.input, {
      count: options.count,
      at: options.at,
      width: options.width,
      quality: options.quality,
      outDir: options.outDir,
    })
    return { frames }
  }
  if (options.action === 'gif') {
    if (options.input === undefined || options.input === '') throw new ProcessError('gif 需要输入文件', 'bad-input')
    const out = path.join(options.outDir, `out_${randomUUID().slice(0, 8)}.gif`)
    await videoToGif(options.input, {
      start: options.start,
      duration: options.duration,
      width: options.width,
      fps: options.fps,
      outPath: out,
    })
    const data = await readFile(out)
    return { output: { file: path.basename(out), mime: 'image/gif', bytes: data.byteLength } }
  }
  if (options.action === 'compress') {
    if (options.input === undefined || options.input === '') throw new ProcessError('compress 需要输入文件', 'bad-input')
    const out = path.join(options.outDir, `out_${randomUUID().slice(0, 8)}.jpg`)
    await compressImage(options.input, { width: options.width, quality: options.quality, outPath: out })
    const data = await readFile(out)
    return { output: { file: path.basename(out), mime: 'image/jpeg', bytes: data.byteLength } }
  }
  if (options.action === 'concat') {
    const inputs = (options.inputs ?? []).map(value => value.trim()).filter(value => value !== '')
    if (inputs.length === 0 && options.input !== undefined && options.input.trim() !== '') inputs.push(options.input.trim())
    if (inputs.length < 2) throw new ProcessError('concat 至少需要 2 个输入片段', 'bad-input')
    const out = path.join(options.outDir, `out_${randomUUID().slice(0, 8)}.mp4`)
    await concatSegments(inputs.map(input => ({ input })), {
      outPath: out,
      width: options.width,
      transition: options.transition,
      fps: options.fps,
      audioUrl: options.audioUrl,
    })
    const data = await readFile(out)
    return { output: { file: path.basename(out), mime: 'video/mp4', bytes: data.byteLength } }
  }
  throw new ProcessError(`未知处理动作: ${options.action}`, 'bad-action')
}
