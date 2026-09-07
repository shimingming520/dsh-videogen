/**
 * Settings card for dsh-videogen (Settings → Plugins → AI 视频): channel
 * CRUD, per-channel secrets, model catalog, default channel, and plugin
 * toggles. Edits are staged locally and committed in one mutate call with
 * per-key secret ops so untouched secrets are never clobbered.
 */

import { useEffect, useMemo, useState } from 'react'
import type { VideogenScope, SettingsOp, VideogenConfig } from './settings-scope.ts'
import { VideogenApi } from './api.ts'
import { tt, errorMessage } from './helpers.ts'
import type { ModelMapping } from '../protocol.ts'
import css from './settings-card.module.css'

interface PresetInfo {
  id: string
  name: string
  apiUrl: string
  description: string
}

interface ChannelDraft {
  id: string
  preset: string
  name: string
  apiUrl: string
  authMode: 'bearer' | 'jwt'
  customJson: string
  models: ModelMapping[]
  /** staged key: undefined = unchanged; '' = clear; else new value */
  keyStaged: string | undefined
}

function idOf(): string {
  return `ch_${Math.random().toString(36).slice(2, 10)}`
}

function modelsToText(models: ModelMapping[]): string {
  return models.map(model => `${model.alias}=${model.id}`).join('\n')
}

function textToModels(text: string): ModelMapping[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').map(line => {
    const equal = line.indexOf('=')
    const alias = equal >= 0 ? line.slice(0, equal).trim() : line
    const id = equal >= 0 ? line.slice(equal + 1).trim() : line
    return { alias: alias === '' ? id : alias, id: id === '' ? alias : id }
  }).filter(model => model.alias !== '')
}

export function VideoGenSettingsCard(props: { scope: VideogenScope }) {
  const [config, setConfig] = useState<VideogenConfig | undefined>(props.scope.getSnapshot().value)
  const [ready, setReady] = useState(props.scope.getSnapshot().status === 'ready')
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [channels, setChannels] = useState<ChannelDraft[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [announce, setAnnounce] = useState(true)
  const [allowAgent, setAllowAgent] = useState(true)
  const [autoSave, setAutoSave] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | undefined>(undefined)

  const api = useMemo(() => new VideogenApi(), [])

  const seed = (value: VideogenConfig | undefined): void => {
    const list = value?.channels ?? []
    const secretsHeld = value === undefined ? {} : props.scope.secretSet
    setChannels(list.map(channel => ({
      id: channel.id,
      preset: channel.preset,
      name: channel.name,
      apiUrl: channel.apiUrl,
      authMode: channel.authMode === 'jwt' ? 'jwt' : 'bearer' as const,
      customJson: channel.customJson ?? '',
      models: channel.models ?? [],
      keyStaged: Object.prototype.hasOwnProperty.call(secretsHeld, `channelSecrets.${channel.id}`) ? undefined : undefined,
    })))
    setDefaultId(value?.defaultChannelId ?? list[0]?.id ?? '')
    setEnabled(value?.enabled !== false)
    setAnnounce(value?.announceToAgent !== false)
    setAllowAgent(value?.allowAgentVideoGeneration !== false)
    setAutoSave(value?.autoSaveToLibrary === true)
  }

  useEffect(() => {
    const unsubscribe = props.scope.subscribe(() => {
      const snapshot = props.scope.getSnapshot()
      setReady(snapshot.status === 'ready')
      setConfig(snapshot.value)
      seed(snapshot.value)
    })
    void props.scope.load()
    void api.presets().then(setPresets).catch(() => setPresets([]))
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dirtyNow = () => setDirty(true)

  const addChannel = (preset: PresetInfo | undefined): void => {
    setChannels(prev => [...prev, {
      id: idOf(),
      preset: preset?.id ?? 'custom',
      name: preset?.name ?? '',
      apiUrl: preset?.apiUrl ?? '',
      authMode: 'bearer',
      customJson: '',
      models: [],
      keyStaged: undefined,
    }])
    dirtyNow()
  }

  const updateChannel = (id: string, patch: Partial<ChannelDraft>): void => {
    setChannels(prev => prev.map(channel => channel.id === id ? { ...channel, ...patch } : channel))
    dirtyNow()
  }

  const commit = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const ops: SettingsOp[] = [
        { op: 'set', path: ['enabled'], value: enabled },
        { op: 'set', path: ['announceToAgent'], value: announce },
        { op: 'set', path: ['allowAgentVideoGeneration'], value: allowAgent },
        { op: 'set', path: ['autoSaveToLibrary'], value: autoSave },
        { op: 'set', path: ['channels'], value: channels.map(channel => ({
          id: channel.id,
          preset: channel.preset,
          name: channel.name,
          apiUrl: channel.apiUrl,
          ...(channel.authMode === 'jwt' ? { authMode: 'jwt' } : {}),
          ...(channel.customJson === '' ? {} : { customJson: channel.customJson }),
          models: channel.models,
        })) },
        { op: 'set', path: ['defaultChannelId'], value: defaultId },
      ]
      for (const channel of channels) {
        if (channel.keyStaged === undefined) continue
        if (channel.keyStaged === '') ops.push({ op: 'unset', path: ['channelSecrets', channel.id] })
        else ops.push({ op: 'set', path: ['channelSecrets', channel.id], value: channel.keyStaged })
      }
      const result = await props.scope.mutate(ops, props.scope.getSnapshot().revision)
      if (!result.ok) {
        setError(result.error ?? '保存失败')
        return
      }
      setConfig(props.scope.getSnapshot().value)
      seed(props.scope.getSnapshot().value)
      setDirty(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    seed(config)
    setDirty(false)
    setError('')
  }

  const hasSecret = (id: string): boolean => props.scope.secretSet(`channelSecrets.${id}`)

  return (
    <div className={css.card}>
      {!ready && <div className={css.hint}>…</div>}
      <label className={css.check}><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); dirtyNow() }} />{tt('settings.enabled')}</label>
      <label className={css.check}><input type="checkbox" checked={announce} onChange={event => { setAnnounce(event.target.checked); dirtyNow() }} />{tt('settings.announceToAgent')}</label>
      <label className={css.check}><input type="checkbox" checked={allowAgent} onChange={event => { setAllowAgent(event.target.checked); dirtyNow() }} />{tt('settings.allowAgentVideo')}</label>
      <label className={css.check}><input type="checkbox" checked={autoSave} onChange={event => { setAutoSave(event.target.checked); dirtyNow() }} />{tt('settings.autoSaveLibrary')}</label>

      <h4 className={css.subtitle}>{tt('channels.title')}</h4>
      <div className={css.hint}>{tt('channels.hint')}</div>
      {channels.length === 0 && <div className={css.hint}>{tt('channels.empty')}</div>}
      {channels.map(channel => (
        <div key={channel.id} className={css.channel}>
          <div className={css.channelRow}>
            <span className={css.channelName}>{channel.name || channel.preset || channel.id}</span>
            {defaultId === channel.id && <span className={css.defaultBadge}>★</span>}
            <button className={css.small} onClick={() => setDefaultId(channel.id)}>{tt('channel.default')}</button>
            <button className={css.small} onClick={() => { setEditing(editing === channel.id ? undefined : channel.id) }}>{tt('channels.edit')}</button>
            <button className={css.small} onClick={() => { setChannels(prev => prev.filter(item => item.id !== channel.id)); dirtyNow() }}>{tt('channels.delete')}</button>
          </div>
          <div className={css.channelMeta}>{presets.find(preset => preset.id === channel.preset)?.name ?? channel.preset} · {channel.apiUrl || '—'} · {channel.models.length} models</div>
          {editing === channel.id && (
            <div className={css.editor}>
              <div className={css.field}>
                <label>{tt('channel.preset')}</label>
                <select value={channel.preset} onChange={event => {
                  const preset = presets.find(item => item.id === event.target.value)
                  updateChannel(channel.id, { preset: event.target.value, ...(preset !== undefined && channel.apiUrl === '' ? { apiUrl: preset.apiUrl, name: preset.name } : {}) })
                }}>
                  {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                </select>
              </div>
              <div className={css.field}><label>{tt('channel.name')}</label><input value={channel.name} onChange={event => updateChannel(channel.id, { name: event.target.value })} /></div>
              <div className={css.field}><label>{tt('channel.apiUrl')}</label><input value={channel.apiUrl} onChange={event => updateChannel(channel.id, { apiUrl: event.target.value })} /></div>
              <div className={css.field}>
                <label>{tt('channel.apiKey')}</label>
                <input
                  type="password"
                  placeholder={hasSecret(channel.id) ? '••••••••' : undefined}
                  value={channel.keyStaged ?? ''}
                  onChange={event => updateChannel(channel.id, { keyStaged: event.target.value })}
                />
                {hasSecret(channel.id) && (
                  <button className={css.small} onClick={() => updateChannel(channel.id, { keyStaged: '' })}>{tt('channels.confirm')}</button>
                )}
              </div>
              <div className={css.hint}>{tt('channel.apiKeyHint')}</div>
              {(channel.preset === 'kling' || channel.preset === 'custom') && (
                <div className={css.field}>
                  <label>{tt('channel.authMode')}</label>
                  <select value={channel.authMode} onChange={event => updateChannel(channel.id, { authMode: event.target.value === 'jwt' ? 'jwt' : 'bearer' })}>
                    <option value="bearer">{tt('channel.authBearer')}</option>
                    <option value="jwt">{tt('channel.authJwt')}</option>
                  </select>
                </div>
              )}
              <div className={css.field}>
                <label>{tt('channel.models')} <button className={css.small} onClick={() => {
                  void api.discoverModels(channel.id).then(result => {
                    updateChannel(channel.id, { models: result.models })
                  }).catch((err: unknown) => setError(tt('channel.modelsDiscoverFailed', { error: errorMessage(err) })))
                }}>{tt('channel.modelsDiscover')}</button></label>
                <textarea value={modelsToText(channel.models)} onChange={event => updateChannel(channel.id, { models: textToModels(event.target.value) })} />
              </div>
              {(channel.preset === 'custom' || channel.preset === 'ark') && (
                <div className={css.field}>
                  <label>{tt('channel.customSpec')}</label>
                  <textarea value={channel.customJson} onChange={event => updateChannel(channel.id, { customJson: event.target.value })} placeholder="{}" />
                  <div className={css.hint}>{tt('channel.customSpecHint')}</div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <div className={css.actions}>
        <button className={css.add} onClick={() => addChannel(presets.find(preset => preset.id === 'openai-compatible'))}>+ {tt('channels.addProvider')}</button>
        <button className={css.add} onClick={() => addChannel(undefined)}>+ {tt('channels.addCustom')}</button>
      </div>

      {error !== '' && <div className={css.error}>{error}</div>}
      <div className={css.actions}>
        <button className={css.primary} disabled={!dirty || saving} onClick={() => { void commit() }}>{saving ? tt('settings.saving') : tt('settings.save')}</button>
        <button className={css.secondary} disabled={!dirty} onClick={discard}>{tt('settings.discard')}</button>
        {dirty && <span className={css.hint}>{tt('settings.unsaved')}</span>}
      </div>
    </div>
  )
}
