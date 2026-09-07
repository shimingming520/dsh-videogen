import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverVideoModels } from './video-models.ts'
import type { VideoChannel } from './video-engine.ts'

function channel(overrides: Partial<VideoChannel> = {}): VideoChannel {
  return {
    id: 'ch-1',
    preset: 'custom',
    name: '测试渠道',
    apiUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    models: [],
    authMode: 'bearer',
    custom: undefined,
    ...overrides,
  }
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { headers: { 'content-type': 'application/json' } })
}

describe('discoverVideoModels', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('自定义渠道：只保留视频相关模型，过滤 LLM/音频/图像模型', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse([
      'wan3.0-video-prime',
      'kimi-k2-thinking',
      'minimax-voice-design',
      'gpt-5.3-codex-spark',
      'gemini-3.5-flash',
      'claude-opus-5',
      'seedance-2.0-mini',
      'seedream-4.5',
      'kling-3.0',
      'music-3.0',
      'eleven_v3',
    ]))

    const { models, source } = await discoverVideoModels(channel())
    const ids = models.map(model => model.id)

    expect(ids).toEqual(['wan3.0-video-prime', 'seedance-2.0-mini', 'kling-3.0'])
    expect(models.every(model => model.category === 'video')).toBe(true)
    expect(source).toContain('视频相关')
  })

  it('OpenAI 兼容渠道：同样只保留视频相关模型', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse([
      'sora-2',
      'gpt-4o',
      'text2video-v1',
      'mini-max-talk',
    ]))

    const { models } = await discoverVideoModels(channel({ preset: 'openai-compatible' }))
    expect(models.map(model => model.id)).toEqual(['sora-2', 'text2video-v1'])
  })

  it('无视频相关模型时返回空列表并说明（不回退全量）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(modelsResponse([
      'gpt-4o',
      'claude-sonnet-4-6',
      'seedream-4.5',
    ]))

    const { models, source } = await discoverVideoModels(channel())
    expect(models).toEqual([])
    expect(source).toContain('未发现视频相关模型')
  })

  it('自定义渠道发现失败：软失败为空列表 + 提示，不抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const { models, source } = await discoverVideoModels(channel())
    expect(models).toEqual([])
    expect(source).toContain('模型发现不可用')
  })

  it('内置厂商（Kling）不探测 /models，直接返回静态目录', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const { models, source } = await discoverVideoModels(channel({ preset: 'kling', apiUrl: 'https://api.klingai.com' }))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(models.length).toBeGreaterThan(0)
    expect(models.some(model => model.id === 'kling-v2-1')).toBe(true)
    expect(source).toBe('内置厂商目录')
  })
})
