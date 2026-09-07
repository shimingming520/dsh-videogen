import { describe, it, expect, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveFFmpeg, probeInfo, extractFrames, videoToGif, compressImage, concatSegments, renderLocalShotCard, wrapText, findFont } from './process-engine.ts'

/** Smoke tests for the FFmpeg processing engine. Skipped when no binary. */
const ffmpegAvailable = (() => {
  try {
    return existsSync(resolveFFmpeg())
  } catch {
    return false
  }
})()

describe.skipIf(!ffmpegAvailable)('ffmpeg processing engine', () => {
  let dir: string
  let sample: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dsh-videogen-test-'))
    sample = path.join(dir, 'sample.mp4')
    await new Promise<void>((resolve, reject) => {
      execFile(resolveFFmpeg(), ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3', '-pix_fmt', 'yuv420p', sample], err => err === null ? resolve() : reject(err))
    })
  })

  it('probes a generated video', async () => {
    const info = await probeInfo(sample)
    expect(info.duration).toBeGreaterThan(2)
    expect(info.width).toBe(320)
    expect(info.height).toBe(240)
    expect(info.videoCodec).toBeDefined()
  })

  it('extracts evenly spaced frames', async () => {
    const frames = await extractFrames(sample, { count: 4, outDir: dir })
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const frame of frames) {
      const data = await readFile(path.join(dir, frame.file))
      expect(data.byteLength).toBeGreaterThan(100)
    }
  })

  it('converts a clip to GIF', async () => {
    const out = path.join(dir, 'out.gif')
    await videoToGif(sample, { width: 160, fps: 8, outPath: out })
    const bytes = (await stat(out)).size
    expect(bytes).toBeGreaterThan(100)
  })

  it('compresses an image (frame as input)', async () => {
    const frames = await extractFrames(sample, { count: 1, outDir: dir })
    const out = path.join(dir, 'compressed.jpg')
    await compressImage(path.join(dir, frames[0]!.file), { width: 160, quality: 5, outPath: out })
    expect((await stat(out)).size).toBeGreaterThan(100)
  })

  it('wraps CJK prompts into lines', () => {
    const lines = wrapText('这是一段比较长的中文提示词用来测试换行是否正确处理中文字符', 12)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]!.length).toBeLessThanOrEqual(12)
  })

  it('renders a local shot card (skipped without a font)', async () => {
    const font = findFont()
    if (font === undefined) return
    const out = path.join(dir, 'card.jpg')
    await renderLocalShotCard({ title: '品牌炫酷开场', prompt: '赛博朋克风格，产品悬浮在黑暗中，聚光灯扫过轮廓，电影感开场镜头', aspectRatio: '16:9', outPath: out })
    expect((await stat(out)).size).toBeGreaterThan(500)
  })

  it('concatenates two segments', async () => {
    const second = path.join(dir, 'second.mp4')
    await new Promise<void>((resolve, reject) => {
      execFile(resolveFFmpeg(), ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p', second], err => err === null ? resolve() : reject(err))
    })
    const out = path.join(dir, 'concat.mp4')
    await concatSegments([{ input: sample, duration: 1 }, { input: second, duration: 1 }], { outPath: out, width: 320, height: 240, transition: 0.3 })
    const info = await probeInfo(out)
    expect(info.width).toBe(320)
    expect(info.duration).toBeGreaterThan(1)
    expect(info.duration).toBeLessThan(3)
  })
})
