// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { VideoGenController } from './controller.ts'
import { mountPanel } from './mount.tsx'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, writable: true })

function scope() {
  return {
    getSnapshot: () => ({ status: 'loading' as const, value: undefined, revision: 0, writable: false, secretSet: {} }),
    subscribe: () => () => {},
  }
}

describe('video panel mounting', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.documentElement.removeAttribute('data-dsh-videogen-active')
  })

  it('控制器未打开时不显示面板容器', async () => {
    const column = document.createElement('div')
    column.dataset.pane = 'conversation'
    document.body.appendChild(column)
    const controller = new VideoGenController()

    let dispose: () => void
    await act(async () => {
      dispose = mountPanel(controller, {} as never, scope() as never, () => false)
    })
    const container = column.querySelector('[data-dsh-videogen-view]') as HTMLElement

    expect(container.hidden).toBe(true)
    await act(async () => controller.open())
    expect(container.hidden).toBe(false)
    await act(async () => dispose!())
  })
})
