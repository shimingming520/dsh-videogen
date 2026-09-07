/**
 * Host-side model discovery for dsh-videogen.
 *
 * OpenAI-compatible /v1/videos channels and custom generic channels answer
 * GET /models; ONLY video-related model ids are kept — this is a video
 * generator, so LLM/audio/image ids from a shared gateway must not leak into
 * the catalog. When the probe fails, built-in presets fall back to their
 * static catalog; custom channels return an empty list with an explanation.
 */

import type { VideoChannel } from './video-engine.ts'
import { videoPresetById } from './video-presets.ts'
import type { DiscoveredVideoModel } from './protocol.ts'

function isPreset(channel: VideoChannel, id: string): boolean {
  return channel.preset === id || channel.apiUrl.toLowerCase().includes(id)
}

function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function videoish(id: string): boolean {
  const value = id.toLowerCase()
  const hits = ['video', 'ttv', 'i2v', 't2v', 'text2video', 'image2video', 'text-to-video', 'image-to-video',
    'sora', 'veo', 'seedance', 'doubao', 'kling', 'hailuo', 'wan', 'mochi', 'cogvideo', 'runway', 'pika',
    'luma', 'movie', 'gen-video', 'videogen']
  return hits.some(hit => value.includes(hit))
}

async function fetchModels(url: string, apiKey: string): Promise<Array<{ id?: string }>> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey.trim()}` } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return Array.isArray(payload.data) ? payload.data : []
}

/** Probe /models and keep ONLY video-related ids (never the full list). */
async function discoverVideoOnlyModels(channel: VideoChannel, source: string): Promise<{ models: DiscoveredVideoModel[]; source: string }> {
  const base = baseUrl(channel.apiUrl)
  const all = await fetchModels(`${base}/models`, channel.apiKey)
  const filtered = all.map(model => model.id?.trim() ?? '').filter(id => id !== '')
  const picked = dedupeIds(filtered.filter(videoish))
  if (picked.length === 0) {
    return { models: [], source: `未发现视频相关模型（/models 共 ${filtered.length} 个）` }
  }
  return {
    models: picked.map(id => ({ alias: id, id, category: 'video' as const })),
    source: `${source}（视频相关，${picked.length} 个）`,
  }
}

/** Discover available video models for a channel. */
export async function discoverVideoModels(channel: VideoChannel): Promise<{ models: DiscoveredVideoModel[]; source: string }> {
  if (channel.apiUrl.trim() === '') throw new Error('API URL 未配置')
  const staticCatalog = (videoPresetById(channel.preset)?.models ?? []).map(model => ({ alias: model.alias, id: model.id }))
  // Kling / MiniMax / ARK: static catalog only (no public listing endpoint).
  if (isPreset(channel, 'kling') || isPreset(channel, 'minimax') || isPreset(channel, 'ark')) {
    return { models: staticCatalog.map(model => ({ ...model, category: 'video' as const })), source: '内置厂商目录' }
  }
  // Custom generic channel: probe /models, keep ONLY video-related ids.
  // Soft-fail: an empty list with an explanatory note beats a 502.
  if (channel.preset === 'custom') {
    try {
      return await discoverVideoOnlyModels(channel, '自定义渠道 /models')
    } catch (error) {
      return { models: [], source: `模型发现不可用（请手动填写目录）：${(error as Error).message.slice(0, 120)}` }
    }
  }
  // OpenAI-compatible: probe /models, keep ONLY video-related ids; on probe
  // failure fall back to the built-in catalog when one exists.
  try {
    return await discoverVideoOnlyModels(channel, 'OpenAI 兼容 /models')
  } catch (error) {
    if (staticCatalog.length > 0) {
      return { models: staticCatalog.map(model => ({ ...model, category: 'video' as const })), source: `内置目录（发现失败：${(error as Error).message.slice(0, 120)}）` }
    }
    throw error
  }
}

function dedupe(models: DiscoveredVideoModel[]): DiscoveredVideoModel[] {
  const seen = new Set<string>()
  const out: DiscoveredVideoModel[] = []
  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

/** Dedupe a plain id list, preserving order. */
function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
