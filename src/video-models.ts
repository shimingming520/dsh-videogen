/**
 * Host-side model discovery for dsh-videogen.
 *
 * OpenAI-compatible /v1/videos channels may answer GET /models; the reply is
 * filtered to video-related model ids when a heuristic matches, otherwise the
 * whole list is offered (capped). Preset vendors with a defined catalog fall
 * back to their static list and never make extra calls.
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
    'sora', 'veo', 'seedance', 'kling', 'hailuo', 'wan', 'mochi', 'cogvideo', 'movie', 'gen-video', 'videogen']
  return hits.some(hit => value.includes(hit))
}

async function fetchModels(url: string, apiKey: string): Promise<Array<{ id?: string }>> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey.trim()}` } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: string }> }
  return Array.isArray(payload.data) ? payload.data : []
}

/** Discover available video models for a channel. */
export async function discoverVideoModels(channel: VideoChannel): Promise<{ models: DiscoveredVideoModel[]; source: string }> {
  if (channel.apiUrl.trim() === '') throw new Error('API URL 未配置')
  const staticCatalog = (videoPresetById(channel.preset)?.models ?? []).map(model => ({ alias: model.alias, id: model.id }))
  // Kling / MiniMax / ARK: static catalog only (no public listing endpoint).
  if (isPreset(channel, 'kling') || isPreset(channel, 'minimax') || isPreset(channel, 'ark') || channel.preset === 'custom') {
    if (staticCatalog.length === 0 && channel.preset === 'custom') {
      return discoverCustomModels(channel)
    }
    return { models: staticCatalog.map(model => ({ ...model, category: 'video' as const })), source: '内置厂商目录' }
  }
  // OpenAI-compatible: probe /models and keep video-related ids (fall back
  // to everything capped at 100 when the heuristic does not match).
  try {
    const base = baseUrl(channel.apiUrl)
    const all = await fetchModels(`${base}/models`, channel.apiKey)
    const filtered = all
      .map(model => model.id?.trim() ?? '')
      .filter(id => id !== '')
    const videoishIds = filtered.filter(videoish)
    const picked = videoishIds.length > 0 ? videoishIds : filtered.slice(0, 100)
    return {
      models: dedupe(picked.map(id => ({ alias: id, id, category: videoish(id) ? ('video' as const) : ('unknown' as const) }))),
      source: videoishIds.length > 0 ? 'OpenAI 兼容 /models（视频相关）' : 'OpenAI 兼容 /models（全量，前 100）',
    }
  } catch (error) {
    if (staticCatalog.length > 0) {
      return { models: staticCatalog.map(model => ({ ...model, category: 'video' as const })), source: `内置目录（发现失败：${(error as Error).message.slice(0, 120)}）` }
    }
    throw error
  }
}

async function discoverCustomModels(channel: VideoChannel): Promise<{ models: DiscoveredVideoModel[]; source: string }> {
  try {
    const all = await fetchModels(`${baseUrl(channel.apiUrl)}/models`, channel.apiKey)
    const filtered = all.map(model => model.id?.trim() ?? '').filter(id => id !== '').slice(0, 100)
    return { models: dedupe(filtered.map(id => ({ alias: id, id, category: videoish(id) ? ('video' as const) : ('unknown' as const) }))), source: '自定义渠道 /models（前 100）' }
  } catch (error) {
    return { models: [], source: `模型发现不可用（请手动填写目录）：${(error as Error).message.slice(0, 120)}` }
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
