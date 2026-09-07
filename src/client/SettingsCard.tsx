/**
 * Settings card for dsh-videogen.
 *
 * The card follows the DSH plugin-settings pattern: it is collapsed by
 * default, exposes a compact channel summary, and opens one focused editor at
 * a time. Drafts are still committed atomically so existing secret handling
 * and revision fencing remain unchanged.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideogenScope, SettingsOp, VideogenConfig } from './settings-scope.ts'
import { VideogenApi } from './api.ts'
import { tt, errorMessage } from './helpers.ts'
import { LLM_MODELS_API, type LlmModelOption, type ModelMapping } from '../protocol.ts'
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
  const snapshot = props.scope.getSnapshot()
  const [config, setConfig] = useState<VideogenConfig | undefined>(snapshot.value)
  const [ready, setReady] = useState(snapshot.status === 'ready')
  const [writable, setWritable] = useState(snapshot.writable)
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [channels, setChannels] = useState<ChannelDraft[]>([])
  const [defaultId, setDefaultId] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [announce, setAnnounce] = useState(true)
  const [allowAgent, setAllowAgent] = useState(true)
  const [autoSave, setAutoSave] = useState(false)
  const [enhanceModel, setEnhanceModel] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [presetLoading, setPresetLoading] = useState(false)
  const [presetError, setPresetError] = useState('')
  const [llmModels, setLlmModels] = useState<LlmModelOption[] | null>(null)
  const [llmModelsError, setLlmModelsError] = useState('')
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const pendingPresetCallbacks = useRef<Array<(items: PresetInfo[]) => void>>([])
  const editingBaseline = useRef<{ channel?: ChannelDraft; dirty: boolean; defaultId: string } | null>(null)
  const [removedSecretIds, setRemovedSecretIds] = useState<string[]>([])

  const api = useMemo(() => new VideogenApi(), [])

  const seed = (value: VideogenConfig | undefined): void => {
    const list = value?.channels ?? []
    setChannels(list.map(channel => ({
      id: channel.id,
      preset: channel.preset,
      name: channel.name,
      apiUrl: channel.apiUrl,
      authMode: channel.authMode === 'jwt' ? 'jwt' : 'bearer',
      customJson: channel.customJson ?? '',
      models: channel.models ?? [],
      keyStaged: undefined,
    })))
    const configuredDefault = value?.defaultChannelId
    setDefaultId(configuredDefault !== undefined && list.some(channel => channel.id === configuredDefault) ? configuredDefault : list[0]?.id ?? '')
    setEnabled(value?.enabled !== false)
    setAnnounce(value?.announceToAgent !== false)
    setAllowAgent(value?.allowAgentVideoGeneration !== false)
    setAutoSave(value?.autoSaveToLibrary === true)
    setEnhanceModel(value?.enhanceModel ?? '')
  }

  useEffect(() => {
    const unsubscribe = props.scope.subscribe(() => {
      const next = props.scope.getSnapshot()
      setReady(next.status === 'ready')
      setWritable(next.writable)
      setConfig(next.value)
      if (!dirtyRef.current) seed(next.value)
    })
    seed(props.scope.getSnapshot().value)
    void props.scope.load()
    return unsubscribe
    // The scope subscription is intentionally established once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    mountedRef.current = false
    pendingPresetCallbacks.current = []
  }, [])

  useEffect(() => {
    if (!open || llmModels !== null || llmModelsError !== '') return
    void fetch(LLM_MODELS_API)
      .then(async response => {
        const body = await response.json() as { ok?: boolean; models?: LlmModelOption[]; message?: string }
        if (!response.ok || body.models === undefined) throw new Error(body.message ?? `HTTP ${response.status}`)
        if (mountedRef.current) setLlmModels(body.models)
      })
      .catch(error => { if (mountedRef.current) setLlmModelsError(errorMessage(error)) })
  }, [open, llmModels, llmModelsError])

  const dirtyNow = (): void => {
    dirtyRef.current = true
    setDirty(true)
  }
  const canEdit = ready && writable && !saving

  const loadPresets = (onLoaded?: (items: PresetInfo[]) => void): void => {
    if (presets.length > 0) {
      onLoaded?.(presets)
      return
    }
    if (presetLoading) {
      if (onLoaded !== undefined) pendingPresetCallbacks.current.push(onLoaded)
      return
    }
    setPresetLoading(true)
    setPresetError('')
    void api.presets()
      .then(items => {
        if (!mountedRef.current) return
        setPresets(items)
        onLoaded?.(items)
        for (const callback of pendingPresetCallbacks.current.splice(0)) callback(items)
      })
      .catch(error => {
        pendingPresetCallbacks.current = []
        if (mountedRef.current) setPresetError(errorMessage(error))
      })
      .finally(() => { if (mountedRef.current) setPresetLoading(false) })
  }

  useEffect(() => {
    if (open) loadPresets()
    // Preset loading is cached for the lifetime of the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const addChannel = (preset: PresetInfo | undefined): void => {
    const channel: ChannelDraft = {
      id: idOf(),
      preset: preset?.id ?? 'custom',
      name: preset?.name ?? '',
      apiUrl: preset?.apiUrl ?? '',
      authMode: 'bearer',
      customJson: '',
      models: [],
      keyStaged: undefined,
    }
    setChannels(prev => [...prev, channel])
    editingBaseline.current = { dirty, defaultId }
    setEditing(channel.id)
    if (channels.length === 0) setDefaultId(channel.id)
    setConfirmDeleteId(null)
    dirtyNow()
  }

  const updateChannel = (id: string, patch: Partial<ChannelDraft>): void => {
    if (!mountedRef.current) return
    setChannels(prev => prev.map(channel => channel.id === id ? { ...channel, ...patch } : channel))
    dirtyNow()
  }

  const updateModelAt = (id: string, index: number, patch: { id?: string; alias?: string }): void => {
    setChannels(prev => prev.map(channel => {
      if (channel.id !== id) return channel
      const models = channel.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model)
      return { ...channel, models }
    }))
    dirtyNow()
  }

  const addModelRow = (id: string): void => {
    setChannels(prev => prev.map(channel => channel.id === id ? { ...channel, models: [...channel.models, { alias: '', id: '' }] } : channel))
    dirtyNow()
  }

  const removeModelAt = (id: string, index: number): void => {
    setChannels(prev => prev.map(channel => channel.id === id ? { ...channel, models: channel.models.filter((_model, modelIndex) => modelIndex !== index) } : channel))
    dirtyNow()
  }

  const removeChannel = (id: string): void => {
    const next = channels.filter(channel => channel.id !== id)
    setChannels(next)
    if (defaultId === id) setDefaultId(next[0]?.id ?? '')
    if (editing === id) setEditing(undefined)
    if (hasSecret(id)) setRemovedSecretIds(current => current.includes(id) ? current : [...current, id])
    editingBaseline.current = null
    setConfirmDeleteId(null)
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
        { op: 'set', path: ['enhanceModel'], value: enhanceModel },
        { op: 'set', path: ['channels'], value: channels.map(channel => ({
          id: channel.id,
          preset: channel.preset,
          name: channel.name.trim(),
          apiUrl: channel.apiUrl.trim(),
          ...(channel.authMode === 'jwt' ? { authMode: 'jwt' } : {}),
          ...(channel.customJson.trim() === '' ? {} : { customJson: channel.customJson }),
          models: channel.models
            .filter(model => model.id.trim() !== '' || model.alias.trim() !== '')
            .map(model => ({ alias: model.alias.trim() === '' ? model.id.trim() : model.alias.trim(), id: model.id.trim() })),
        })) },
        { op: 'set', path: ['defaultChannelId'], value: defaultId },
      ]
      for (const channel of channels) {
        if (channel.keyStaged === undefined) continue
        if (channel.keyStaged === '') ops.push({ op: 'unset', path: ['channelSecrets', channel.id] })
        else ops.push({ op: 'set', path: ['channelSecrets', channel.id], value: channel.keyStaged })
      }
      for (const id of removedSecretIds) {
        if (!channels.some(channel => channel.id === id)) ops.push({ op: 'unset', path: ['channelSecrets', id] })
      }
      const result = await props.scope.mutate(ops, props.scope.getSnapshot().revision)
      if (!result.ok) {
        setError(result.error ?? '保存失败')
        return
      }
      const next = props.scope.getSnapshot().value
      setConfig(next)
      seed(next)
      dirtyRef.current = false
      editingBaseline.current = null
      setRemovedSecretIds([])
      setDirty(false)
      setEditing(undefined)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    seed(config)
    dirtyRef.current = false
    editingBaseline.current = null
    setRemovedSecretIds([])
    setDirty(false)
    setError('')
    setEditing(undefined)
    setConfirmDeleteId(null)
  }

  const hasSecret = (id: string): boolean => props.scope.secretSet(`channelSecrets.${id}`)
  const presetName = (id: string): string => presets.find(preset => preset.id === id)?.name ?? id
  const beginEditing = (id: string): void => {
    const channel = channels.find(item => item.id === id)
    if (channel === undefined) return
    editingBaseline.current = { channel: { ...channel, models: channel.models.map(model => ({ ...model })) }, dirty, defaultId }
    setConfirmDeleteId(null)
    setEditing(id)
  }
  const cancelEditing = (): void => {
    const baseline = editingBaseline.current
    if (baseline?.channel === undefined) {
      setChannels(current => current.filter(channel => channel.id !== editing))
      setDefaultId(baseline?.defaultId ?? defaultId)
      setEditing(undefined)
      editingBaseline.current = null
      return
    }
    setChannels(current => current.map(channel => channel.id === baseline.channel!.id ? baseline.channel! : channel))
    setDefaultId(baseline.defaultId)
    dirtyRef.current = baseline.dirty
    setDirty(baseline.dirty)
    setEditing(undefined)
    editingBaseline.current = null
  }

  return (
    <div className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-controls="videogen-settings-body"
        aria-label={`${tt(open ? 'settings.collapse' : 'settings.expand')}: ${tt('settings.title')}`}
        onClick={() => setOpen(value => !value)}
      >
        <span className={css.headText}>
          <span className={css.name}>{tt('settings.title')}</span>
          <span className={css.description}>{tt('settings.description')}</span>
        </span>
        {dirty ? <span className={css.pending}>{tt('settings.unsaved')}</span> : null}
        <span className={open ? css.chevronOpen : css.chevron} aria-hidden="true">▾</span>
      </button>

      {!open ? null : (
        <div id="videogen-settings-body" className={css.body} data-settings-body>
          {!ready ? <p className={css.readOnly} role="status">…</p> : null}
          {!writable ? <p className={css.readOnly} role="status">{tt('settings.readOnly')}</p> : null}

          <section className={css.channelSection} aria-label={tt('channels.title')}>
            <div className={css.sectionHeader}>
              <div>
                <h3 className={css.sectionTitle}>{tt('channels.title')}</h3>
                <p className={css.sectionHint}>{tt('channels.hint')}</p>
              </div>
            </div>
            {channels.length === 0 ? <p className={css.channelEmpty}>{tt('channels.empty')}</p> : (
              <ul className={css.channelList}>
                {channels.map(channel => {
                  const keyHeld = hasSecret(channel.id)
                  const complete = keyHeld && channel.models.length > 0
                  const isDefault = defaultId === channel.id
                  if (confirmDeleteId === channel.id) {
                    return (
                      <li key={channel.id} className={css.channelRow} data-action>
                        <span className={css.deleteConfirmText}>{tt('channels.confirm')}: {channel.name || tt('channels.untitled')}</span>
                        <button type="button" className={css.channelDanger} disabled={!canEdit} onClick={() => removeChannel(channel.id)}>{tt('channels.confirm')}</button>
                        <button type="button" className={css.channelAction} onClick={() => setConfirmDeleteId(null)}>{tt('channels.cancel')}</button>
                      </li>
                    )
                  }
                  return (
                    <li key={channel.id} className={css.channelRow}>
                      <span className={complete ? css.channelDotReady : css.channelDotWarn} aria-hidden="true" title={tt(complete ? 'channels.statusReady' : 'channels.statusIncomplete')} />
                      <button type="button" className={css.channelMain} disabled={!canEdit} onClick={() => beginEditing(channel.id)}>
                        <span className={css.channelName}>{isDefault ? `★ ${channel.name || tt('channels.untitled')}` : (channel.name || tt('channels.untitled'))}</span>
                        <span className={css.channelMeta}>
                          <span className={css.channelHost}>{channel.apiUrl || '—'}</span>
                          <span className={css.channelBadge} data-warn={!keyHeld || channel.models.length === 0 ? '' : undefined}>
                            {keyHeld ? tt('channels.keySet') : tt('channels.keyMissing')}
                            {' · '}
                            {channel.models.length > 0 ? tt('channels.modelCount', { n: channel.models.length }) : tt('channels.noModels')}
                          </span>
                        </span>
                      </button>
                      <button type="button" className={css.channelAction} disabled={!canEdit} onClick={() => beginEditing(channel.id)}>{tt('channels.edit')}</button>
                      <button type="button" className={css.channelAction} disabled={!canEdit} data-danger onClick={() => { setEditing(undefined); setConfirmDeleteId(channel.id) }}>{tt('channels.delete')}</button>
                    </li>
                  )
                })}
              </ul>
            )}

            {presetError !== '' ? <p className={css.failed}>{presetError}</p> : null}
            <div className={css.channelAddRow}>
              <button type="button" className={css.channelAdd} disabled={!canEdit} onClick={() => loadPresets(items => addChannel(items.find(preset => preset.id === 'openai-compatible')))}>
                {presetLoading ? tt('channels.addProviderLoading') : tt('channels.addProvider')}
              </button>
              <button type="button" className={css.channelAdd} disabled={!canEdit} onClick={() => addChannel(undefined)}>{tt('channels.addCustom')}</button>
            </div>

            {editing !== undefined ? (() => {
              const channel = channels.find(item => item.id === editing)
              if (channel === undefined) return null
              const selectedPreset = presets.find(preset => preset.id === channel.preset)
              const persisted = config?.channels?.some(item => item.id === channel.id) === true
              return (
                <div className={css.editorWrap}>
                  <div className={css.channelEditor}>
                    <div className={css.editorHeader}>
                      <span className={css.editorTitle}>{channel.name || tt('channels.untitled')}</span>
                      <span className={css.editorTag}>{tt('channel.editTitle')}</span>
                    </div>
                    <div className={css.field}>
                      <label className={css.label} htmlFor={`video-channel-name-${channel.id}`}>{tt('channel.name')}</label>
                      <input id={`video-channel-name-${channel.id}`} className={css.input} value={channel.name} placeholder={tt('channel.namePlaceholder')} disabled={!canEdit} onChange={event => updateChannel(channel.id, { name: event.target.value })} />
                    </div>
                    <div className={css.field}>
                      <div className={css.head}>
                        <label className={css.label} htmlFor={`video-channel-key-${channel.id}`}>{tt('channel.apiKey')}</label>
                        {hasSecret(channel.id) && channel.keyStaged === undefined ? <button type="button" className={css.reset} disabled={!canEdit} onClick={() => updateChannel(channel.id, { keyStaged: '' })}>{tt('channel.clearKey')}</button> : null}
                      </div>
                      <input id={`video-channel-key-${channel.id}`} className={css.input} type="password" autoComplete="new-password" data-lpignore="true" placeholder={hasSecret(channel.id) && channel.keyStaged !== '' ? tt('channel.apiKeyStoredPlaceholder') : tt('channel.apiKeyPlaceholder')} value={channel.keyStaged ?? ''} disabled={!canEdit} onChange={event => updateChannel(channel.id, { keyStaged: event.target.value === '' ? undefined : event.target.value })} onFocus={event => {
                        // A password manager may have filled the box before focus; if the DOM value
                        // differs from our controlled state, reset it so no stale credential sticks.
                        const expected = channel.keyStaged ?? ''
                        if (event.currentTarget.value !== expected) {
                          event.currentTarget.value = ''
                          updateChannel(channel.id, { keyStaged: undefined })
                        }
                      }} />
                      <p className={css.sectionHint}>{hasSecret(channel.id) ? tt('channel.apiKeyStoredHint') : tt('channel.apiKeyHint')}</p>
                    </div>
                    <details className={css.customSettings}>
                      <summary className={css.customSettingsSummary}>{tt('channel.customSettings')}</summary>
                      <div className={css.customSettingsBody}>
                        <div className={css.field}>
                          <label className={css.label} htmlFor={`video-channel-preset-${channel.id}`}>{tt('channel.preset')}</label>
                          <select id={`video-channel-preset-${channel.id}`} className={css.select} value={channel.preset} disabled={!canEdit} onChange={event => {
                            const preset = presets.find(item => item.id === event.target.value)
                            updateChannel(channel.id, {
                              preset: event.target.value,
                              ...(preset !== undefined ? {
                                apiUrl: preset.apiUrl,
                                name: channel.name || preset.name,
                                authMode: 'bearer',
                                ...(preset.id !== 'custom' && preset.id !== 'ark' ? { customJson: '' } : {}),
                              } : {}),
                            })
                          }}>
                            {presets.length === 0 ? <option value={channel.preset}>{presetName(channel.preset)}</option> : presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                          </select>
                          {selectedPreset?.description ? <p className={css.sectionHint}>{selectedPreset.description}</p> : null}
                        </div>
                        <div className={css.field}>
                          <label className={css.label} htmlFor={`video-channel-url-${channel.id}`}>{tt('channel.apiUrl')}</label>
                          <input id={`video-channel-url-${channel.id}`} className={css.input} value={channel.apiUrl} placeholder={selectedPreset?.apiUrl ?? tt('channel.apiUrlPlaceholder')} disabled={!canEdit} onChange={event => updateChannel(channel.id, { apiUrl: event.target.value })} />
                          <p className={css.sectionHint}>{tt('channel.apiUrlHint')}</p>
                        </div>
                        {(channel.preset === 'kling' || channel.preset === 'custom') ? (
                          <div className={css.field}>
                            <label className={css.label} htmlFor={`video-channel-auth-${channel.id}`}>{tt('channel.authMode')}</label>
                            <select id={`video-channel-auth-${channel.id}`} className={css.select} value={channel.authMode} disabled={!canEdit} onChange={event => updateChannel(channel.id, { authMode: event.target.value === 'jwt' ? 'jwt' : 'bearer' })}>
                              <option value="bearer">{tt('channel.authBearer')}</option>
                              <option value="jwt">{tt('channel.authJwt')}</option>
                            </select>
                          </div>
                        ) : null}
                        {(channel.preset === 'custom' || channel.preset === 'ark') ? (
                          <div className={css.field}>
                            <label className={css.label} htmlFor={`video-channel-spec-${channel.id}`}>{tt('channel.customSpec')}</label>
                            <textarea id={`video-channel-spec-${channel.id}`} className={css.textarea} value={channel.customJson} placeholder="{}" disabled={!canEdit} onChange={event => updateChannel(channel.id, { customJson: event.target.value })} />
                            <p className={css.sectionHint}>{tt('channel.customSpecHint')}</p>
                          </div>
                        ) : null}
                      </div>
                    </details>
                    <div className={css.modelSection}>
                      <div className={css.modelHead}>
                        <div>
                          <span className={css.label}>{tt('channel.models')}</span>
                          <span className={css.sectionHint}>{channel.models.length > 0 ? tt('channels.modelCount', { n: channel.models.length }) : tt('channels.noModels')}</span>
                        </div>
                        <button type="button" className={css.linkButton} disabled={!canEdit || !persisted} title={persisted ? undefined : tt('channel.discoverNeedsSave')} onClick={() => { void api.discoverModels(channel.id).then(result => updateChannel(channel.id, { models: result.models })).catch(error => setError(tt('channel.modelsDiscoverFailed', { error: errorMessage(error) }))) }}>{tt('channel.modelsDiscover')}</button>
                      </div>
                      <div className={css.modelsRows} data-testid="models-editor">
                        {channel.models.map((model, index) => (
                          <div key={`${channel.id}-${index}`} className={css.modelRow}>
                            <input className={css.modelId} value={model.id} placeholder="上游模型 ID" disabled={!canEdit} onChange={event => updateModelAt(channel.id, index, { id: event.target.value })} />
                            <input className={css.modelAlias} value={model.alias} placeholder="显示名称" disabled={!canEdit} onChange={event => updateModelAt(channel.id, index, { alias: event.target.value })} />
                            <button type="button" className={css.modelRemove} disabled={!canEdit} aria-label={tt('channels.delete')} onClick={() => removeModelAt(channel.id, index)}>×</button>
                          </div>
                        ))}
                        <button type="button" className={css.addModel} disabled={!canEdit} onClick={() => addModelRow(channel.id)}>+ {tt('channel.addModel')}</button>
                      </div>
                      <p className={css.sectionHint}>{tt('channel.modelsHint')}</p>
                    </div>
                    <label className={css.defaultField}>
                      <input type="checkbox" checked={defaultId === channel.id} disabled={!canEdit} onChange={event => { if (event.target.checked) { setDefaultId(channel.id); dirtyNow() } }} /> {tt('channel.default')}
                    </label>
                    <div className={css.editorFooter}>
                      <button type="button" className={css.discard} onClick={cancelEditing}>{tt('channel.cancel')}</button>
                      <button type="button" className={css.save} disabled={!canEdit} onClick={() => { editingBaseline.current = null; setEditing(undefined) }}>{tt('channel.save')}</button>
                    </div>
                  </div>
                </div>
              )
            })() : null}
          </section>

          <div className={css.field}>
            <label className={css.label} htmlFor="video-enhance-model">{tt('settings.enhanceModel')}</label>
            <select id="video-enhance-model" className={css.select} value={enhanceModel} disabled={!canEdit} onChange={event => { setEnhanceModel(event.target.value); dirtyNow() }}>
              <option value="">{tt('settings.enhanceModelDefault')}</option>
              {llmModels?.map(option => <option key={`${option.provider}|${option.id}`} value={`${option.provider}|${option.id}`}>{`${option.providerName} — ${option.name}${option.name !== option.id ? `（${option.id}）` : ''}`}</option>)}
              {llmModels !== null && enhanceModel !== '' && !llmModels.some(option => `${option.provider}|${option.id}` === enhanceModel) ? <option value={enhanceModel}>{enhanceModel}</option> : null}
            </select>
            <p className={css.sectionHint}>{tt('settings.enhanceModelHint')}</p>
            {llmModelsError !== '' ? <p className={css.failed}>{tt('settings.enhanceModelFailed')}：{llmModelsError}</p> : null}
          </div>
          <label className={css.check}><input type="checkbox" checked={enabled} disabled={!canEdit} onChange={event => { setEnabled(event.target.checked); dirtyNow() }} />{tt('settings.enabled')}</label>
          <label className={css.check}><input type="checkbox" checked={announce} disabled={!canEdit} onChange={event => { setAnnounce(event.target.checked); dirtyNow() }} />{tt('settings.announceToAgent')}</label>
          <label className={css.check}><input type="checkbox" checked={allowAgent} disabled={!canEdit} onChange={event => { setAllowAgent(event.target.checked); dirtyNow() }} />{tt('settings.allowAgentVideo')}</label>
          <label className={css.check}><input type="checkbox" checked={autoSave} disabled={!canEdit} onChange={event => { setAutoSave(event.target.checked); dirtyNow() }} />{tt('settings.autoSaveLibrary')}</label>

          {error !== '' ? <p className={css.failed}>{error}</p> : null}
          <div className={css.footer}>
            {dirty ? <span className={css.sectionHint}>{tt('settings.unsaved')}</span> : <span />}
            <button type="button" className={css.discard} disabled={!dirty || saving} onClick={discard}>{tt('settings.discard')}</button>
            <button type="button" className={css.save} disabled={!dirty || saving || !writable} onClick={() => { void commit() }}>{saving ? tt('settings.saving') : tt('settings.save')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
