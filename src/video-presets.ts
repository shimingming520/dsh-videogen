/**
 * Host-side vendor preset catalog for dsh-videogen.
 *
 * Each preset carries a display name, a default API base, the auth layout and
 * the models known for that vendor (used as a fallback catalog when the
 * channel cannot list models). The engine keys off `channel.preset` to pick
 * the upstream protocol.
 */

import type { CustomChannelSpec, ModelMapping } from './protocol.ts'

export interface VideoPreset {
  id: string
  name: string
  /** Default API base URL prefilled in the settings card. */
  apiUrl: string
  authMode: 'bearer' | 'jwt'
  /** Whether the channel uses async submit + poll (true) or may answer sync. */
  async: boolean
  description: string
  /** Fallback model catalog. */
  models: ModelMapping[]
  /** Default aspect ratios the vendor accepts (panel hint). */
  aspectRatios?: string[]
  /** Default durations (seconds) the vendor accepts. */
  durations?: number[]
  /** Default custom spec for the `custom` preset form. */
  custom?: CustomChannelSpec
}

interface PresetModelDef {
  alias: string
  id: string
}

function models(defs: PresetModelDef[]): ModelMapping[] {
  return defs.map(def => ({ alias: def.alias, id: def.id }))
}

export const VIDEO_PRESETS: VideoPreset[] = [
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容（/v1/videos）',
    apiUrl: 'https://api.openai.com/v1',
    authMode: 'bearer',
    async: true,
    description: 'POST /v1/videos 提交 + GET /v1/videos/{id} 轮询（Sora 规格）；中转站/聚合网关普遍支持。',
    models: models([
      { alias: 'sora-2', id: 'sora-2' },
      { alias: 'sora-2-pro', id: 'sora-2-pro' },
      { alias: 'video-01', id: 'video-01' },
    ]),
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10, 15],
  },
  {
    id: 'kling',
    name: '可灵 Kling',
    apiUrl: 'https://api.klingai.com',
    authMode: 'jwt',
    async: true,
    description: 'POST /v1/videos/text2video|image2video + 任务轮询。密钥支持两种格式：直接 API Token（Bearer）或 "AccessKey:SecretKey"（自动 JWT HMAC-SHA256 签名）。',
    models: models([
      { alias: 'kling-v1-6', id: 'kling-v1-6' },
      { alias: 'kling-v2-1', id: 'kling-v2-1' },
      { alias: 'kling-v2-1-pro', id: 'kling-v2-1-pro' },
      { alias: 'kling-v2-master', id: 'kling-v2-master' },
      { alias: 'kling-v2-master-pro', id: 'kling-v2-master-pro' },
    ]),
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 10],
  },
  {
    id: 'minimax',
    name: '海螺 MiniMax',
    apiUrl: 'https://api.minimaxi.com/v1',
    authMode: 'bearer',
    async: true,
    description: 'POST /v1/video_generation/v1|/v1/image_to_video/v1 提交，任务轮询 + /v1/files/retrieve/{file_id} 取下载地址。GroupId 可附在 apiUrl 查询参数（?GroupId=xxx）。',
    models: models([
      { alias: 'video-01', id: 'video-01' },
      { alias: 'video-01-live2d', id: 'video-01-live2d' },
      { alias: 'hailuo-2-3', id: 'hailuo-2-3' },
      { alias: 'hailuo-02', id: 'hailuo-02' },
      { alias: 'hailuo-02-pro', id: 'hailuo-02-pro' },
    ]),
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [5, 6, 10],
  },
  {
    id: 'ark',
    name: '即梦/火山 ARK（豆包 Seedance）',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authMode: 'bearer',
    async: true,
    description: '火山方舟视频生成任务 API：POST /contents/generations/tasks + GET 轮询（OpenAI 兼容风格）。',
    models: models([
      { alias: 'doubao-seedance-1-0-pro-250528', id: 'doubao-seedance-1-0-pro-250528' },
      { alias: 'doubao-seedance-1-0-lite-i2v-250428', id: 'doubao-seedance-1-0-lite-i2v-250428' },
      { alias: 'doubao-seedance-1-5-pro', id: 'doubao-seedance-1-5-pro' },
    ]),
    aspectRatios: ['16:9', '9:16', '4:3', '1:1'],
    durations: [5, 10],
    custom: {
      submitUrl: '{{base}}/contents/generations/tasks',
      bodyTemplate: '{"model":"{{model}}","content":[{"type":"text","text":"{{prompt}}"}]}',
      taskIdPath: 'id',
      pollUrlTemplate: '{{base}}/contents/generations/tasks/{{taskId}}',
      statusPath: 'status',
      doneValues: 'succeeded',
      failValues: 'failed,cancelled,error',
      resultUrlPath: 'content.video_url',
    },
  },
  {
    id: 'custom',
    name: '自定义通用渠道',
    apiUrl: 'https://example.com/v1',
    authMode: 'bearer',
    async: true,
    description: '完全自定义：提交 URL、请求体 JSON 模板（{{prompt}}/{{model}}/{{image}}/{{duration}}…）、任务 id 取值路径、轮询 URL 模板、状态/完成值、结果 URL 路径。',
    models: [],
    custom: {
      submitUrl: '{{base}}/videos',
      bodyTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
      taskIdPath: 'task_id',
      pollUrlTemplate: '{{base}}/videos/{{taskId}}',
      pollMethod: 'GET',
      statusPath: 'status',
      doneValues: 'completed,succeeded,success',
      failValues: 'failed,error,cancelled',
      resultUrlPath: 'data.videos[0].url,data.video_url,data.url,content.video_url,video_url,result.url',
      apiKeyHeader: 'Authorization',
      apiKeyScheme: 'Bearer',
    },
  },
]

export function videoPresetById(id: string): VideoPreset | undefined {
  return VIDEO_PRESETS.find(preset => preset.id === id)
}

/** All preset ids, ordered by the catalog. */
export function videoPresetIds(): string[] {
  return VIDEO_PRESETS.map(preset => preset.id)
}
