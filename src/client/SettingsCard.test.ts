// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VideoGenSettingsCard } from './SettingsCard.tsx'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

function fakeScope(overrides: { defaultChannelId?: string } = {}) {
  const snapshot = {
    status: 'ready' as const,
    value: {
      enabled: true,
      channels: [{
        id: 'ch-1',
        preset: 'openai-compatible',
        name: '主视频渠道',
        apiUrl: 'https://example.com/v1',
        models: [{ alias: 'sora-2', id: 'sora-2' }],
      }],
      defaultChannelId: overrides.defaultChannelId ?? 'ch-1',
    },
    revision: 1,
    writable: true,
    secretSet: { 'channelSecrets.ch-1': true } as Record<string, boolean>,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    load: async () => {},
    secretSet: (path: string) => snapshot.secretSet[path] === true,
    mutate: vi.fn(async () => ({ ok: true })),
  }
}

describe('VideoGenSettingsCard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('默认收起设置内容，点击标题后展开', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).includes('/llm/models') ? { models: [] } : { presets: [] },
    ), { headers: { 'content-type': 'application/json' } }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(VideoGenSettingsCard, { scope: fakeScope() as never }))
    })

    expect(container.querySelector('[aria-expanded="false"]')).not.toBeNull()
    expect(container.querySelector('[data-settings-body]')).toBeNull()

    await act(async () => {
      container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {})
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull()
    expect(container.querySelector('[data-settings-body]')).not.toBeNull()
    await act(async () => root.unmount())
    container.remove()
  })

  it('加载 LLM 模型目录时使用 GET 并接受 models 响应', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ input, init })
      const isLlm = String(input).includes('/llm/models')
      return new Response(JSON.stringify(isLlm ? { models: [] } : { presets: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: fakeScope() as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => {})

    const llmCall = calls.find(call => String(call.input).includes('/llm/models'))
    expect(llmCall?.init?.method ?? 'GET').toBe('GET')
    expect(container.textContent).not.toContain('模型列表加载失败')
    await act(async () => root.unmount())
  })

  it('无效默认渠道回退到第一个渠道', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(String(input).includes('/llm/models') ? { models: [] } : { presets: [] }), {
      headers: { 'content-type': 'application/json' },
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: fakeScope({ defaultChannelId: '' }) as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.textContent).toContain('★ 主视频渠道')
    await act(async () => root.unmount())
  })

  it('取消渠道编辑会恢复编辑前的内容', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(String(input).includes('/llm/models') ? { models: [] } : { presets: [] }), {
      headers: { 'content-type': 'application/json' },
    }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: fakeScope() as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '编辑')?.click())
    const input = container.querySelector<HTMLInputElement>('#video-channel-name-ch-1')
    await act(async () => {
      if (input !== null) {
        input.value = '临时名称'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '取消')?.click())

    expect(container.textContent).toContain('主视频渠道')
    expect(container.textContent).not.toContain('临时名称')
    await act(async () => root.unmount())
  })

  it('删除渠道时保存会清理对应密钥', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => new Response(JSON.stringify(String(input).includes('/llm/models') ? { models: [] } : { presets: [] }), {
      headers: { 'content-type': 'application/json' },
    }))
    const scope = fakeScope()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: scope as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '删除')?.click())
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '确认删除')?.click())
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存' && !button.closest('[data-settings-body]')?.querySelector('button.channelDanger'))
      ?? [...container.querySelectorAll<HTMLButtonElement>('button')].at(-1)
    await act(async () => saveButton?.click())
    await act(async () => {})

    const mutate = scope.mutate as unknown as ReturnType<typeof vi.fn>
    const ops = mutate.mock.calls[0]?.[0] as Array<{ op: string; path: string[] }>
    expect(ops).toContainEqual({ op: 'unset', path: ['channelSecrets', 'ch-1'] })
    await act(async () => root.unmount())
  })

  it('获取可用模型：候选列表不直接填充，勾选后导入才写入目录', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/llm/models')) {
        return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/models/discover')) {
        return new Response(JSON.stringify({
          models: [
            { alias: 'kling-v2-1', id: 'kling-v2-1', category: 'video' },
            { alias: 'sora-2', id: 'sora-2', category: 'video' },
            { alias: 'gpt-4o', id: 'gpt-4o', category: 'unknown' },
            { alias: 'music-3.0', id: 'music-3.0', category: 'unknown' },
          ],
          source: '测试来源',
        }), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ presets: [] }), { headers: { 'content-type': 'application/json' } })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: fakeScope() as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '编辑')?.click())

    // 目录现状：仅 sora-2（id + 别名两个输入框）
    let rows = [...container.querySelectorAll<HTMLInputElement>('[data-testid="models-editor"] input')].map(input => input.value)
    expect(rows.filter(value => value === 'sora-2').length).toBe(2)

    // 点击获取可用模型 → 展示候选面板，但不直接写入目录
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '✨ 获取可用模型')?.click())
    await act(async () => {})

    expect(container.querySelector('[data-testid="model-candidates"]')).not.toBeNull()
    expect(container.textContent).toContain('kling-v2-1')
    expect(container.textContent).toContain('sora-2')
    expect(container.textContent).toContain('已在目录')
    // 客户端兜底过滤：非视频模型（gpt-4o / music-3.0）不进入候选列表
    expect(container.textContent).not.toContain('gpt-4o')
    expect(container.textContent).not.toContain('music-3.0')
    rows = [...container.querySelectorAll<HTMLInputElement>('[data-testid="models-editor"] input')].map(input => input.value)
    expect(rows.filter(value => value === 'kling-v2-1').length).toBe(0)

    // 导入选中（默认选中新模型 kling-v2-1；已存在的 sora-2 自动勾选但不可取消）
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('导入选中'))?.click())
    await act(async () => {})

    expect(container.querySelector('[data-testid="model-candidates"]')).toBeNull()
    rows = [...container.querySelectorAll<HTMLInputElement>('[data-testid="models-editor"] input')].map(input => input.value)
    expect(rows.filter(value => value === 'sora-2').length).toBe(2)
    expect(rows.filter(value => value === 'kling-v2-1').length).toBe(2)
    await act(async () => root.unmount())
  })

  it('获取可用模型：发现失败时显示错误且不污染目录', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/llm/models')) return new Response(JSON.stringify({ models: [] }), { headers: { 'content-type': 'application/json' } })
      if (url.includes('/models/discover')) return new Response(JSON.stringify({ ok: false, message: 'HTTP 401' }), { status: 502, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ presets: [] }), { headers: { 'content-type': 'application/json' } })
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(createElement(VideoGenSettingsCard, { scope: fakeScope() as never })))
    await act(async () => container.querySelector('button[aria-expanded]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '编辑')?.click())

    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '✨ 获取可用模型')?.click())
    await act(async () => {})

    expect(container.querySelector('[data-testid="model-candidates"]')).toBeNull()
    expect(container.textContent).toContain('模型发现失败')
    // 目录仍未变化：只有原 sora-2 一行（两个输入框）
    const rows = [...container.querySelectorAll<HTMLInputElement>('[data-testid="models-editor"] input')].map(input => input.value)
    expect(rows.filter(value => value === 'sora-2').length).toBe(2)
    await act(async () => root.unmount())
  })
})
