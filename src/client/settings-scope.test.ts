// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { VideogenScope } from './settings-scope.ts'

/**
 * The exact wire shape the loopback bridge answers for GET
 * /api/dsh-videogen/settings/describe: a single namespace view (raw
 * toView(descriptor)), NOT the { namespaces: [...] } envelope.
 */
function wireResponse(overrides: Record<string, unknown> = {}) {
  return {
    ns: 'dsh-videogen',
    value: {
      enabled: true,
      channels: [{
        id: 'ch-1',
        preset: 'openai-compatible',
        name: '主视频渠道',
        apiUrl: 'https://example.com/v1',
        models: [{ alias: 'sora-2', id: 'sora-2' }],
      }],
      defaultChannelId: 'ch-1',
    },
    base: { enabled: true, channels: [] },
    secrets: [{ path: ['channelSecrets', 'ch-1'], set: true }],
    revision: 3,
    ...overrides,
  }
}

function fetchReturning(body: unknown): typeof fetch {
  return async () => ({ json: async () => body }) as Response
}

describe('VideogenScope bridge reload', () => {
  it('从单命名空间 describe 响应恢复配置与密钥标记', async () => {
    const scope = new VideogenScope(fetchReturning(wireResponse()) as never)
    await scope.load()

    const snapshot = scope.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.writable).toBe(true)
    expect(snapshot.revision).toBe(3)
    expect(snapshot.value?.channels?.[0]?.name).toBe('主视频渠道')
    expect(scope.secretSet('channelSecrets.ch-1')).toBe(true)
    expect(scope.secretSet('channelSecrets.no-such')).toBe(false)
  })

  it('无密钥标记时 secretSet 全为 false', async () => {
    const scope = new VideogenScope(fetchReturning(wireResponse({ secrets: [] })) as never)
    await scope.load()

    expect(scope.secretSet('channelSecrets.ch-1')).toBe(false)
  })

  it('未注册命名空间时降级为空配置（不进入 unavailable）', async () => {
    const scope = new VideogenScope(fetchReturning({ ns: 'dsh-videogen' }) as never)
    await scope.load()

    const snapshot = scope.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.value).toEqual({})
  })
})
