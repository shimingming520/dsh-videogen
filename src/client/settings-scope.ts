/**
 * Browser-side settings scope for the dsh-videogen namespace, served by the
 * plugin's own loopback bridge routes (/api/dsh-videogen/settings).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

import { SETTINGS_API } from '../protocol.ts'

/** The fields this plugin's settings card edits. */
export interface VideogenConfig {
  enabled?: boolean
  announceToAgent?: boolean
  allowAgentVideoGeneration?: boolean
  channels?: Array<{
    id: string
    preset: string
    name: string
    apiUrl: string
    authMode?: string
    customJson?: string
    models: Array<{ alias: string; id: string }>
  }>
  channelSecrets?: Record<string, string>
  defaultChannelId?: string
  defaultModel?: string
  autoSaveToLibrary?: boolean
  enhanceModel?: string
}

export type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

interface BridgeView {
  ns: string
  value: unknown
  base?: unknown
  user?: unknown
  revision: number
  secrets?: Array<{ path: string[]; set: boolean }>
}

type BridgeEnvelope =
  | { ok: true; value: { namespaces?: BridgeView[]; writable?: boolean } | BridgeView }
  | { ok: false; code: string; message: string }

function createBridgeApi(fetchFn: typeof fetch): {
  settings: {
    describe(payload: Record<string, never>): Promise<{ result: BridgeEnvelope }>
    mutate(payload: { ns: string; ops: unknown[]; expectedRevision?: number }): Promise<{ result: BridgeEnvelope }>
  }
} {
  const get = async (path: string): Promise<{ result: BridgeEnvelope }> => {
    try {
      const response = await fetchFn(path, { headers: { accept: 'application/json' } })
      const body = (await response.json()) as { ns?: string; value?: unknown; revision?: number; writable?: boolean; ok?: boolean; code?: string; message?: string }
      if ('ns' in body && body.ns === 'dsh-videogen') {
        return { result: { ok: true, value: { ns: 'dsh-videogen', value: body.value ?? {}, revision: Number(body.revision ?? 0), writable: true } } }
      }
      return { result: { ok: false, code: body.code ?? 'bridge-error', message: body.message ?? 'settings bridge failed' } }
    } catch (error) {
      return { result: { ok: false, code: 'bridge-error', message: error instanceof Error ? error.message : String(error) } }
    }
  }
  const post = async (path: string, body: unknown): Promise<{ result: BridgeEnvelope }> => {
    try {
      const response = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as BridgeEnvelope
      return { result: payload }
    } catch (error) {
      return { result: { ok: false, code: 'bridge-error', message: error instanceof Error ? error.message : String(error) } }
    }
  }
  return {
    settings: {
      describe: (payload) => get(SETTINGS_API.describe),
      mutate: (payload) => post(SETTINGS_API.mutate, payload),
    },
  }
}

const MAX_SECRETS = 64

export interface VideogenScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value: VideogenConfig | undefined
  revision: number
  writable: boolean
  error?: string
  /** secret key → set flag (from the bridge secrets sidecar). */
  secretSet: Record<string, boolean>
}

export class VideogenScope {
  readonly store: SnapshotStore<VideogenScopeSnapshot>
  private readonly api: ReturnType<typeof createBridgeApi>
  private loaded: Promise<void> | undefined

  constructor(fetchFn: typeof fetch) {
    this.api = createBridgeApi(fetchFn)
    this.store = createSnapshotStore<VideogenScopeSnapshot>({
      status: 'loading',
      value: undefined,
      revision: 0,
      writable: false,
      secretSet: {},
    })
  }

  async load(): Promise<void> {
    this.loaded ??= this.reload()
    return this.loaded
  }

  async reload(): Promise<void> {
    const { result } = await this.api.settings.describe({})
    if (result.ok === false) {
      this.store.set({ status: 'unavailable', value: undefined, revision: 0, writable: false, secretSet: {}, error: result.message })
      return
    }
    const view = result.value as { namespaces?: BridgeView[]; writable?: boolean } | BridgeView
    const entry = 'namespaces' in view && Array.isArray(view.namespaces) ? view.namespaces.find(item => item.ns === 'dsh-videogen') : undefined
    if (entry === undefined) {
      this.store.set({ status: 'ready', value: undefined, revision: 0, writable: 'writable' in view && view.writable === true, secretSet: {} })
      return
    }
    const secretSet: Record<string, boolean> = {}
    for (const secret of entry.secrets ?? []) {
      secretSet[secret.path.join('.')] = secret.set
    }
    this.store.set({
      status: 'ready',
      value: (entry.value ?? {}) as VideogenConfig,
      revision: Number(entry.revision ?? 0),
      writable: 'writable' in view && view.writable === true,
      secretSet,
    })
  }

  getSnapshot(): VideogenScopeSnapshot {
    return this.store.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Whether one secret path currently holds a stored value. */
  secretSet(path: string): boolean {
    return this.store.getSnapshot().secretSet[path] === true
  }

  async mutate(ops: SettingsOp[], expectedRevision?: number): Promise<{ ok: boolean; error?: string }> {
    const { result } = await this.api.settings.mutate({
      ns: 'dsh-videogen',
      ops,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    })
    if (result.ok === false) return { ok: false, error: result.message }
    await this.reload()
    return { ok: true }
  }

  /** Read one secret path placeholder (set/unset) without the value. */
  secretPlaceholders(): Array<{ path: string[]; set: boolean }> {
    return Object.entries(this.store.getSnapshot().secretSet).map(([path, set]) => ({ path: path.split('.'), set }))
  }
}

/** Build the scope with a fetch that stays loopback-only. */
export function bindVideogenScope(fetchFn: typeof fetch): VideogenScope {
  return new VideogenScope(fetchFn)
}
