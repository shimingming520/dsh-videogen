/**
 * Browser-half entry for dsh-videogen.
 *
 * Registers locale dictionaries, the settings card (Settings → Plugins → AI
 * 视频), and mounts the sidebar entry + generation panel. DOM mounting
 * failures are logged, never thrown.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { VideogenApi } from './api.ts'
import { VideoGenController } from './controller.ts'
import { tt } from './helpers.ts'
import { en, zh, type VideoGenKey } from './locales.ts'
import { mountPanel } from './mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { VideoGenSettingsCard } from './SettingsCard.tsx'
import { bindVideogenScope, type VideogenScope } from './settings-scope.ts'

const NS = 'dsh-videogen'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-videogen': VideoGenKey
  }
}

/** Settings-card face: intentionally empty — the shell closes over its scope. */
interface VideoGenSettingsCardFace {
  /* empty */
}

export const inject = ['slots', 'locale', 'connection', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-videogen: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const loopback = connection?.isLoopback === true
  const scope: VideogenScope = bindVideogenScope(loopback
    ? (input, init) => fetch(input, init)
    : () => { throw new Error('settings bridge is loopback-only') })

  ctx.effect(() => {
    const disposers = [
      ctx.on('connection/reset', () => { void scope.load() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-videogen: settings scope invalidation')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: () => ({} satisfies VideoGenSettingsCardFace),
  }, function VideoGenSettingsCardShell(props: PropsRuntime<'settings.plugin.item'> & PropsLocale<'dsh-videogen'> & InjectFace<VideoGenSettingsCardFace>) {
    void props
    // The card owns its staged state and closes over the scope from apply().
    return <VideoGenSettingsCard scope={scope} />
  }))

  let uiDisposer: (() => void) | undefined
  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    const controller = new VideoGenController()
    const api = new VideogenApi()
    const disposers: Array<() => void> = []
    try {
      disposers.push(mountSidebarEntry(controller, tt('entry.label'), tt('entry.tooltip')))
      disposers.push(mountPanel(controller, api, scope, () => (scope.getSnapshot().value?.channels ?? []).length > 0))
    } catch (error) {
      console.warn('[dsh-videogen] mount failed:', error)
    }
    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      uiDisposer = undefined
    }
  }
  const syncEnabled = (): void => {
    const snapshot = scope.getSnapshot()
    const enabled = snapshot.status === 'ready'
      ? snapshot.value?.enabled ?? true
      : snapshot.status === 'unavailable'
    if (enabled) mountUi()
  }

  const scopeUnsub = scope.subscribe(syncEnabled)
  void scope.load().then(syncEnabled)
  syncEnabled()
  const resetUnsub = scope.subscribe(() => { /* state reachable via panel props */ })
  void resetUnsub

  ctx.effect(() => {
    return () => {
      scopeUnsub()
      uiDisposer?.()
      uiDisposer = undefined
    }
  }, 'dsh-videogen: ui teardown')
}
