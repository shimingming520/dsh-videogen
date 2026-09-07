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
})
