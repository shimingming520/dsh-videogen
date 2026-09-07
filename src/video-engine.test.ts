import { describe, it, expect } from 'vitest'
import { dotPath, substituteTemplate, findUrl, klingJwt, detectVideoMime } from './video-engine.ts'
import { fillTemplate, createProjectFromTemplate, updateShot, shotInputs } from './studio-engine.ts'
import { parseGenerateRequest } from './generate-core.ts'

describe('video-engine helpers', () => {
  it('reads dot paths including array indexes', () => {
    const value = { data: { videos: [{ url: 'https://a/b.mp4' }], status: 'succeed' } }
    expect(dotPath(value, 'data.videos[0].url')).toBe('https://a/b.mp4')
    expect(dotPath(value, 'data.status')).toBe('succeed')
    expect(dotPath(value, 'data.missing')).toBeUndefined()
    expect(dotPath(value, 'data.videos[3].url')).toBeUndefined()
  })

  it('substitutes {{placeholders}}', () => {
    const out = substituteTemplate('{"prompt":"{{prompt}}","model":"{{model}}"}', { prompt: 'hello', model: 'm', taskId: '' })
    expect(out).toBe('{"prompt":"hello","model":"m"}')
    // unknown placeholders are kept as-is
    expect(substituteTemplate('{{base}}/videos/{{taskId}}', { taskId: 'x' })).toBe('{{base}}/videos/x')
  })

  it('finds the first url recursively', () => {
    expect(findUrl({ data: [{ video_url: 'https://x/y.mp4' }] })).toBe('https://x/y.mp4')
    expect(findUrl({ data: [{ file_id: 1 }] })).toBeUndefined()
    expect(findUrl('https://direct.mp4')).toBe('https://direct.mp4')
  })

  it('builds a Kling JWT with valid shape', () => {
    const jwt = klingJwt('ak', 'sk')
    const [header, payload, signature] = jwt.split('.')
    expect(header).toBeDefined()
    expect(payload).toBeDefined()
    expect(signature).toBeDefined()
    const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString())
    expect(decodedHeader.alg).toBe('HS256')
    const decodedPayload = JSON.parse(Buffer.from(payload!, 'base64url').toString())
    expect(decodedPayload.iss).toBe('ak')
    // signature is deterministic for the same key pair
    expect(klingJwt('ak', 'sk', 1800).split('.')[0]).toBe(header)
  })

  it('detects mp4 magic bytes', () => {
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    expect(detectVideoMime(mp4)).toBe('video/mp4')
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])
    expect(detectVideoMime(webm)).toBe('video/webm')
  })
})

describe('generate request parsing', () => {
  it('parses and normalizes a generate request', () => {
    const parsed = parseGenerateRequest({
      mode: 'image2video',
      prompt: '  江水奔流  ',
      channelId: 'ch1',
      model: 'kling-v2-1',
      negativePrompt: '模糊',
      aspectRatio: '16:9',
      duration: 5,
      enhancePrompt: true,
      waitSeconds: 120,
      saveToLibrary: true,
    })
    expect(parsed).toBeDefined()
    expect(parsed!.prompt).toBe('江水奔流')
    expect(parsed!.mode).toBe('image2video')
    expect(parsed!.duration).toBe(5)
    expect(parsed!.enhancePrompt).toBe(true)
  })

  it('rejects an empty prompt', () => {
    expect(parseGenerateRequest({ prompt: '   ' })).toBeUndefined()
  })
})

describe('storyboard engine', () => {
  it('creates a project from a template and fills variables', () => {
    const project = createProjectFromTemplate('brand-sizzle', '测试', { product: 'NEON X1' })
    expect(project.shots.length).toBe(4)
    expect(project.shots[0]!.prompt).toContain('NEON X1')
    expect(project.shots[0]!.prompt).not.toContain('{{product}}')
    expect(project.aspectRatio).toBe('16:9')
  })

  it('updates a shot and clears its ready state after a prompt edit', () => {
    let project = createProjectFromTemplate('brand-sizzle', '测试', { product: 'X' })
    project = { ...project, shots: project.shots.map(shot => ({ ...shot, status: 'ready' as const, videoUrl: 'https://v.mp4' })) }
    const shotId = project.shots[0]!.id
    project = updateShot(project, shotId, { prompt: '新提示词' })
    expect(project.shots[0]!.status).toBe('pending')
    expect(project.shots[0]!.prompt).toBe('新提示词')
    expect(shotInputs(project).length).toBe(3) // the edited shot is no longer ready
  })
})
