/**
 * Lightweight storyboard studio engine.
 *
 * Bundles cinematic shot templates inspired by the iVideo / HyperFrames
 * template library (brand sizzle, product launch, data story, social
 * vertical, feature orbit, release spotlight). A project holds resolved
 * shots; each shot can be produced by a generation channel and the whole
 * board is composed into one video with FFmpeg. Templates never carry
 * external assets — everything is prompt-driven.
 */

import { randomUUID } from 'node:crypto'
import type { StoryboardProject, StoryboardShot, StoryboardShotTemplate, StoryboardTemplate } from './protocol.ts'

export interface StoryboardTemplateDefinition extends StoryboardTemplate {
  /** Prompt help asked of the LLM if variables are unfilled. */
  hint?: string
}

export const STORYBOARD_TEMPLATES: StoryboardTemplateDefinition[] = [
  {
    id: 'brand-sizzle',
    name: '品牌炫酷开场',
    description: '快速节奏的品牌氛围片：产品 → 特写 → 环境 → 收束。',
    aspectRatio: '16:9',
    duration: 15,
    variables: [
      { key: 'product', label: '产品名/品类', hint: '如 NEON X1 无线耳机' },
      { key: 'style', label: '风格基调', hint: '如 赛博朋克、极简、胶片' },
    ],
    shots: [
      { id: 's1', name: '开场', duration: 3, transition: 0.5, prompt: '{{style}}风格，产品 "{{product}}" 悬浮在黑暗中，聚光灯扫过轮廓，电影感开场镜头', motion: 'slow push-in' },
      { id: 's2', name: '特写', duration: 3, transition: 0.6, prompt: '{{product}} 超近距离微距特写，表面材质高光流动，{{style}}光效', motion: 'dolly in' },
      { id: 's3', name: '环境', duration: 3, transition: 0.6, prompt: '{{product}} 在品牌主色调场景中旋转展示，周围光粒环绕，{{style}}氛围', motion: 'orbit' },
      { id: 's4', name: '收束', duration: 3, transition: 0.5, prompt: '{{product}} 定格在画面中央，背景渐变为品牌色，顶部留白给标题', motion: 'static' },
    ],
    hint: '为 {{product}} 生成一套品牌视频的分镜提示词。',
  },
  {
    id: 'product-launch',
    name: '产品发布流程片',
    description: '发布会叙事：痛点 → 揭晓 → 功能亮点 → 行动号召。',
    aspectRatio: '16:9',
    duration: 20,
    variables: [
      { key: 'product', label: '产品名/品类' },
      { key: 'pain', label: '解决的痛点', hint: '如 充电慢、续航短' },
    ],
    shots: [
      { id: 's1', name: '痛点', duration: 4, transition: 0.5, prompt: '用户日常场景缓慢镜头，暗示"{{pain}}"的烦恼，暗淡色调', motion: 'slow pan' },
      { id: 's2', name: '揭晓', duration: 4, transition: 0.8, prompt: '产品 "{{product}}" 从幕布后揭开，光束点亮，发布会级揭晓镜头', motion: 'push in' },
      { id: 's3', name: '亮点', duration: 4, transition: 0.6, prompt: '{{product}} 功能演示特写，动态信息光效标注功能点', motion: 'orbit' },
      { id: 's4', name: '号召', duration: 4, transition: 0.5, prompt: '{{product}} 首发落地页风格画面，产品居中构图上，大标题区域留白', motion: 'static' },
    ],
    hint: '为 {{product}}（解决 {{pain}}）生成产品发布视频分镜。',
  },
  {
    id: 'data-story',
    name: '数据证明故事',
    description: '数据叙事：数字上升 → 对比 → 趋势 → 结论，信息图表感。',
    aspectRatio: '16:9',
    duration: 16,
    variables: [
      { key: 'metric', label: '核心指标', hint: '如 转化率 +42%' },
      { key: 'context', label: '业务背景' },
    ],
    shots: [
      { id: 's1', name: '背景', duration: 4, transition: 0.5, prompt: '{{context}}：数据图表在深色背景上浮现，干净的科技感', motion: 'slow zoom' },
      { id: 's2', name: '上升', duration: 4, transition: 0.6, prompt: '折线图快速上升动画，高亮 {{metric}}，数字粒子聚集', motion: 'camera fly-through' },
      { id: 's3', name: '对比', duration: 4, transition: 0.6, prompt: '前后对比分屏，旧方案暗淡 vs 新方案明亮，{{metric}} 大数字居中', motion: 'static split' },
      { id: 's4', name: '结论', duration: 4, transition: 0.5, prompt: '{{metric}} 巨大数字定格，副标题区域留白，总结画面', motion: 'static' },
    ],
    hint: '围绕 {{context}} 与 {{metric}} 生成数据叙事分镜。',
  },
  {
    id: 'vertical-social',
    name: '竖版社媒短视频',
    description: '9:16 短视频节奏：钩子 → 展示 → 卖点 → 关注引导。',
    aspectRatio: '9:16',
    duration: 15,
    variables: [
      { key: 'subject', label: '主题内容' },
      { key: 'tone', label: '语气', hint: '如 轻松、硬核、治愈' },
    ],
    shots: [
      { id: 's1', name: '钩子', duration: 3, transition: 0.4, prompt: '{{tone}}基调，开场钩子画面：{{subject}} 相关震撼一瞬间', motion: 'fast punch-in' },
      { id: 's2', name: '展示', duration: 4, transition: 0.5, prompt: '{{subject}} 主体内容展示，垂直构图，标题条区域留白', motion: 'orbit' },
      { id: 's3', name: '卖点', duration: 4, transition: 0.5, prompt: '{{subject}} 核心卖点特写，动态强调元素', motion: 'slow dolly' },
      { id: 's4', name: '引导', duration: 3, transition: 0.4, prompt: '{{subject}} 收尾定格，关注引导（follow）按钮区域留白', motion: 'static' },
    ],
    hint: '用 {{tone}} 的语气为 {{subject}} 生成竖版社媒视频分镜。',
  },
  {
    id: 'feature-orbit',
    name: '特性巡礼',
    description: '围绕产品的功能特性环绕展示，适合功能向内容。',
    aspectRatio: '16:9',
    duration: 18,
    variables: [
      { key: 'product', label: '产品名/品类' },
      { key: 'features', label: '特性列表', hint: '逗号分隔，如 秒传、无损、多端同步' },
    ],
    shots: [
      { id: 's1', name: '引入', duration: 4, transition: 0.5, prompt: '{{product}} 全景入场，环境感强，品牌色打底', motion: 'orbit in' },
      { id: 's2', name: '特性一', duration: 4, transition: 0.6, prompt: '{{product}} 特性演示：{{features}} 第一条，动态图解', motion: 'tilt up' },
      { id: 's3', name: '特性二', duration: 4, transition: 0.6, prompt: '{{product}} 特性演示：{{features}} 第二条，动态图解', motion: 'orbit' },
      { id: 's4', name: '总结', duration: 4, transition: 0.5, prompt: '{{product}} 与特性列表同框，列表区域留白', motion: 'static' },
    ],
    hint: '为 {{product}}（{{features}}）生成功能特性巡礼分镜。',
  },
  {
    id: 'release-spotlight',
    name: '版本发布高光',
    description: '版本发布悬念烘托：倒计时 → 揭晓 → 更新亮点 → 下载入口。',
    aspectRatio: '16:9',
    duration: 16,
    variables: [
      { key: 'version', label: '版本号', hint: '如 v3.0' },
      { key: 'highlights', label: '亮点' },
    ],
    shots: [
      { id: 's1', name: '倒计时', duration: 4, transition: 0.5, prompt: '{{version}} 发布倒计时动画，数字逐帧变化，暗色激光氛围', motion: 'zoom out' },
      { id: 's2', name: '揭晓', duration: 4, transition: 0.8, prompt: '{{version}} 巨型版本号点亮，光效爆开，发布高光', motion: 'punch-in' },
      { id: 's3', name: '亮点', duration: 4, transition: 0.6, prompt: '{{highlights}} 动态展示，每个亮点带独立视觉', motion: 'orbit' },
      { id: 's4', name: '入口', duration: 4, transition: 0.5, prompt: '{{version}} 下载按钮区域留白，背景可做品牌渐变', motion: 'static' },
    ],
    hint: '为 {{version}}（{{highlights}}）生成版本发布高光分镜。',
  },
]

export function storyboardTemplateById(id: string): StoryboardTemplateDefinition | undefined {
  return STORYBOARD_TEMPLATES.find(template => template.id === id)
}

/** Substitute {{var}} placeholders from the project variables. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, raw: string) => {
    const key = raw.trim()
    return Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== '' ? vars[key] : match
  })
}

/** Create a new storyboard project from a template + variables. */
export function createProjectFromTemplate(templateId: string, name: string, vars: Record<string, string>): StoryboardProject {
  const template = storyboardTemplateById(templateId)
  if (template === undefined) throw new Error(`未知分镜模板: ${templateId}`)
  const shots: StoryboardShot[] = template.shots.map((shot: StoryboardShotTemplate) => ({
    id: `${shot.id}_${randomUUID().slice(0, 6)}`,
    name: shot.name,
    prompt: fillTemplate(shot.prompt, vars),
    duration: shot.duration,
    transition: shot.transition,
    status: 'pending',
    params: {
      templateShotId: shot.id,
      motion: shot.motion,
      ...(shot.imagePrompt !== undefined ? { imagePrompt: shot.imagePrompt } : {}),
    },
  }))
  const now = Date.now()
  return {
    id: randomUUID(),
    name,
    templateId,
    aspectRatio: template.aspectRatio,
    vars,
    shots,
    createdAt: now,
    updatedAt: now,
  }
}

/** Update one shot's editable fields. */
export function updateShot(project: StoryboardProject, shotId: string, patch: Partial<Pick<StoryboardShot, 'prompt' | 'name' | 'duration' | 'transition' | 'imageUrl'>>): StoryboardProject {
  const shots = project.shots.map(shot => {
    if (shot.id !== shotId) return shot
    const next = { ...shot, ...patch }
    if (patch.prompt !== undefined || patch.imageUrl !== undefined) next.status = 'pending'
    return next
  })
  return { ...project, shots, updatedAt: Date.now() }
}

/** Map all shots to concat inputs once they have video assets. */
export function shotInputs(project: StoryboardProject): Array<{ input: string; duration?: number }> {
  return project.shots
    .filter(shot => shot.videoUrl !== undefined && shot.videoUrl !== '' && shot.status === 'ready')
    .map(shot => ({ input: shot.videoUrl!, duration: shot.duration }))
}
