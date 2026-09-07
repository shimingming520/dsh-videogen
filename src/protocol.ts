/**
 * Wire contract shared by the host and client halves of dsh-videogen:
 * settings namespace, route paths, generate/process payload and result
 * shapes. Pure types and constants — safe for the client bundle to inline.
 */

/** Settings namespace this plugin owns (host settings seam + bridge). */
export const VIDE0GEN_SETTINGS_NAMESPACE = 'dsh-videogen'

/** Published package version shared by the host updater and the client UI. */
export const PLUGIN_VERSION = '0.1.0'

/** Same-origin route family (loopback-only, mirroring dsh-audiogen). */
export const SETTINGS_API = {
  describe: '/api/dsh-videogen/settings/describe',
  mutate: '/api/dsh-videogen/settings/mutate',
} as const

/** Video-generation submission route. */
export const GENERATE_API = {
  start: '/api/dsh-videogen/generate/start',
  query: '/api/dsh-videogen/generate/query',
  cancel: '/api/dsh-videogen/generate/cancel',
} as const

/** FFmpeg processing route. */
export const PROCESS_API = '/api/dsh-videogen/process/run' as const

/** Storyboard studio route. */
export const STUDIO_API = {
  templates: '/api/dsh-videogen/studio/templates',
  projects: '/api/dsh-videogen/studio/projects',
  project: '/api/dsh-videogen/studio/project',
  compose: '/api/dsh-videogen/studio/compose',
} as const

/** History and library routes. */
export const HISTORY_API = '/api/dsh-videogen/history' as const
export const LIBRARY_API = '/api/dsh-videogen/library' as const

/** Host-mediated built-in provider catalog. */
export const PRESETS_API = '/api/dsh-videogen/presets' as const

/** Host-mediated model discovery endpoint. */
export const MODEL_API = {
  discover: '/api/dsh-videogen/models/discover',
} as const

/** LLM 模型目录：提示词增强模型的候选（来自「设置 → 模型」各提供方）。 */
export const LLM_MODELS_API = '/api/dsh-videogen/llm/models' as const

/** Loopback-only prompt enhancement route (uses the agent's default model). */
export const ENHANCE_API = '/api/dsh-videogen/prompt/enhance' as const

/** Same-origin asset serving (generated videos, frames, gifs, images). */
export const ASSETS_API = '/api/dsh-videogen/assets' as const

/** History cap for the storage document. */
export const HISTORY_MAX = 200

/** Library cap per type (video / image / gif / storyboard). */
export const LIBRARY_NAME_MAX = 96

/** Library resource types. */
export const LIBRARY_TYPES = ['video', 'image', 'gif', 'storyboard'] as const
export type LibraryType = typeof LIBRARY_TYPES[number]

/** Generation modes. */
export const VIDEO_MODES = ['text2video', 'image2video'] as const
export type VideoMode = typeof VIDEO_MODES[number]

/** One model/alias entry in a channel catalog. */
export interface ModelMapping {
  alias: string
  id: string
}

/** Custom generic async channel spec (decoded from channel.customJson). */
export interface CustomChannelSpec {
  /** POST endpoint for the submit call; may contain {{base}} and placeholder fields. */
  submitUrl: string
  /** JSON body template; placeholders {{prompt}} {{model}} {{image}} {{negative_prompt}} {{duration}} {{aspect_ratio}} {{resolution}} {{seed}}. */
  bodyTemplate?: string
  /** Dot path to the task id in the submit response (default "task_id"). */
  taskIdPath?: string
  /** Poll URL template (default "{{base}}/task/{{taskId}}"); {{base}} = apiUrl root. */
  pollUrlTemplate?: string
  /** Poll method (GET default). */
  pollMethod?: string
  /** Dot path to the status field (default "status"). */
  statusPath?: string
  /** Comma-separated status values meaning done (default "completed,succeeded,success"). */
  doneValues?: string
  /** Comma-separated status values meaning failure (default "failed,error,cancelled"). */
  failValues?: string
  /** Comma-separated candidate dot paths for the result video URL (default "data.videos[0].url,data.video_url,data.url,content.video_url,video_url"). */
  resultUrlPath?: string
  /** API key header name (default "Authorization"). */
  apiKeyHeader?: string
  /** API key scheme prefix (default "Bearer"; empty = raw). */
  apiKeyScheme?: string
}

/** A resolved video channel (key included; never logged). */
export interface VideoChannelConfig {
  id: string
  preset: string
  name: string
  apiUrl: string
  /** API key; secret-role, stored in channelSecrets. */
  apiKey: string
  models: ModelMapping[]
  /** Kling JWT layout: "accessKey:secretKey" in apiKey → JWT signing; else Bearer. */
  authMode: 'bearer' | 'jwt'
  custom: CustomChannelSpec | undefined
}

/** Channel config as persisted in settings (no secret). */
export interface StoredChannelConfig {
  id: string
  preset: string
  name: string
  apiUrl: string
  models: ModelMapping[]
  authMode: 'bearer' | 'jwt'
  customJson: string
}

/** Generate request (panel + agent both go through this shape). */
export interface GenerateVideoRequest {
  mode: VideoMode
  channelId?: string
  /** Model alias or upstream id. */
  model?: string
  prompt: string
  /** For image2video: http(s) URL, data: URL, or local path read by the host. */
  image?: string
  negativePrompt?: string
  aspectRatio?: string
  /** Upstream duration in seconds (model-dependent). */
  duration?: number
  /** Upstream resolution / size (e.g. "1024x1792"); provider-dependent. */
  resolution?: string
  seed?: number
  enhancePrompt?: boolean
  saveToLibrary?: boolean
  /** Wait for completion (panel/agent default true). */
  wait?: boolean
  /** Max wait seconds (default 240). */
  waitSeconds?: number
}

/** One produced video. */
export interface GeneratedVideo {
  /** Same-origin URL of the cached copy. */
  url: string
  /** Original upstream URL. */
  remoteUrl?: string
  /** Local file name under the asset dir. */
  file?: string
  mime?: string
  bytes?: number
  duration?: number
  width?: number
  height?: number
}

/** Unified task status. */
export type TaskStatus = 'submitted' | 'processing' | 'completed' | 'failed'

/** Serializable upstream task reference (persisted for later queries). */
export interface TaskRef {
  kind: 'openai' | 'kling-t2v' | 'kling-i2v' | 'minimax-t2v' | 'minimax-i2v' | 'custom'
  taskId: string
  /** Poll URL with {{taskId}} replaced already; may be relative to base. */
  pollUrl?: string
  pollMethod?: string
  statusPath?: string
  doneValues?: string
  failValues?: string
  resultUrlPath?: string
  /** MiniMax: file id retrieved from poll response before the result URL. */
  fileRetrievePath?: string
}

/** Generate outcome returned by start/query. */
export interface GenerateResult {
  status: TaskStatus
  taskId?: string
  videos: GeneratedVideo[]
  error?: string
  channelId?: string
  model?: string
  prompt?: string
}

/** Add a generate record to history. */
export interface HistoryEntry {
  id: string
  taskId: string
  channelId?: string
  channel?: string
  model?: string
  mode: VideoMode
  prompt: string
  image?: string
  negativePrompt?: string
  aspectRatio?: string
  duration?: number
  resolution?: string
  seed?: number
  params?: Record<string, unknown>
  taskRef?: TaskRef
  status: TaskStatus
  videos: Array<{ url: string; remoteUrl?: string; file?: string; mime?: string; bytes?: number; duration?: number; width?: number; height?: number }>
  error?: string
  createdAt: number
}

/** Library entry for a video result. */
export interface LibraryEntry {
  id: string
  type: LibraryType
  name: string
  tags?: string[]
  category?: string
  file?: string
  url?: string
  provenance: {
    channelId?: string
    channel?: string
    model?: string
    mode?: VideoMode
    prompt?: string
    params?: Record<string, unknown>
    createdAt: number
  }
  createdAt: number
}

/** Processing actions. */
export type ProcessAction = 'info' | 'frames' | 'gif' | 'compress' | 'concat'

/** Process request (panel + agent). */
export interface ProcessRequest {
  action: ProcessAction
  /** http(s) URL, workspace-relative (ws/<workspaceId>/<path>), or absolute path. */
  input?: string
  /** Comma-separated inputs for concat (urls or workspace paths). */
  inputs?: string[]
  /** frames */
  count?: number
  at?: number
  /** compression / frames / gif */
  width?: number
  /** ffmpeg JPEG quality 1-31 (lower is better). */
  quality?: number
  /** gif */
  start?: number
  duration?: number
  fps?: number
  /** concat */
  transition?: number
  audioUrl?: string
  output?: string
}

/** Info result. */
export type VideoInfoResult = {
  duration?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
  fps?: number
  sizeBytes?: number
  raw: string
}

/** Process outcome. */
export interface ProcessResult {
  /** info */
  info?: VideoInfoResult
  /** frames */
  frames?: Array<{ url?: string; file: string; name: string }>
  /** gif / compress / concat output */
  output?: {
    url?: string
    file: string
    bytes: number
    mime: string
  }
  error?: string
}

/** Storyboard template (bundled shots + variable placeholders). */
export interface StoryboardShotTemplate {
  id: string
  name: string
  duration: number
  transition: number
  /** Prompt with {{var}} placeholders; empty → skip AI, use a simple slide. */
  prompt: string
  imagePrompt?: string
  /** Camera / motion suggestion for the upstream generator. */
  motion?: string
}

export interface StoryboardTemplate {
  id: string
  name: string
  description: string
  aspectRatio: string
  /** Recommended total video duration hint. */
  duration: number
  /** User-supplied variables referenced by {{var}} in shot prompts. */
  variables: Array<{ key: string; label: string; hint?: string }>
  shots: StoryboardShotTemplate[]
}

/** One shot of a concrete project. */
export interface StoryboardShot {
  id: string
  name: string
  prompt: string
  imageUrl?: string
  duration: number
  transition: number
  /** Generated video asset url once produced. */
  videoUrl?: string
  /** status of this shot. */
  status: 'pending' | 'generating' | 'ready' | 'failed'
  error?: string
  params?: Record<string, unknown>
}

export interface StoryboardProject {
  id: string
  name: string
  templateId: string
  aspectRatio: string
  vars: Record<string, string>
  shots: StoryboardShot[]
  createdAt: number
  updatedAt: number
}

/** One discovered model entry. */
export interface DiscoveredVideoModel {
  alias: string
  id: string
  category?: 'video' | 'image' | 'unknown'
  description?: string
}

/** Available LLM model option (prompt enhancement candidates). */
export interface LlmModelOption {
  provider: string
  providerName: string
  id: string
  name: string
}
