// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoGenPanel } from './VideoGenPanel.tsx'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

function loadingScope() {
  return {
    getSnapshot: () => ({
      status: 'loading' as const,
      value: undefined,
      revision: 0,
      writable: false,
      secretSet: {},
    }),
    subscribe: () => () => {},
  }
}

describe('VideoGenPanel startup state', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('加载配置期间不显示未配置提示', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(createElement(VideoGenPanel, {
        api: {} as never,
        scope: loadingScope() as never,
        channelsReady: () => false,
      }))
    })

    expect(container.textContent).toContain('正在加载视频配置')
    expect(container.textContent).not.toContain('尚未配置视频 API')
    await act(async () => root.unmount())
  })
})
