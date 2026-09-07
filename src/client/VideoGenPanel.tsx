/**
 * VideoGenPanel: the AI 视频 panel with four tabs (Generate / Process /
 * Studio / Library), rendered inside the center column like dsh-imagegen /
 * dsh-audiogen panels.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { VideogenApi } from './api.ts'
import type { VideogenScope, VideogenScopeSnapshot } from './settings-scope.ts'
import { tt, errorMessage } from './helpers.ts'
import type { GenerateResult, LibraryEntry, ProcessResult, StoryboardProject, StoryboardTemplate } from '../protocol.ts'
import css from './panel.module.css'

interface PanelProps {
  api: VideogenApi
  scope: VideogenScope
  channelsReady: () => boolean
}

export function VideoGenPanel(props: PanelProps) {
  const [tab, setTab] = useState<'generate' | 'process' | 'studio' | 'library'>('generate')
  const [config, setConfig] = useState<VideogenScopeSnapshot>(props.scope.getSnapshot())
  useEffect(() => { const unsubscribe = props.scope.subscribe(() => { setConfig(props.scope.getSnapshot()) }); return unsubscribe }, [props.scope])

  const channels = config.value?.channels ?? []
  const haveChannels = channels.length > 0
  const enabled = config.value?.enabled !== false
  if (config.status === 'loading') {
    return <div className={css.viewEmpty}>{tt('config.loading')}</div>
  }
  if (!enabled) {
    return <div className={css.viewEmpty}>{tt('config.disabled')}</div>
  }
  if (!haveChannels) {
    return <div className={css.viewEmpty}>{tt('config.missing')}</div>
  }
  return (
    <div className={css.panel}>
      <div className={css.tabs}>
        {(['generate', 'process', 'studio', 'library'] as const).map(key => (
          <button key={key} className={tab === key ? `${css.tab} ${css.tabActive}` : css.tab} onClick={() => setTab(key)}>{tt(`tab.${key}` as never)}</button>
        ))}
      </div>
      {tab === 'generate' && <GenerateView api={props.api} channels={channels} />}
      {tab === 'process' && <ProcessView api={props.api} />}
      {tab === 'studio' && <StudioView api={props.api} channels={channels} />}
      {tab === 'library' && <LibraryView api={props.api} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Generate                                                          */
/* ------------------------------------------------------------------ */

function GenerateView(props: { api: VideogenApi; channels: Array<{ id: string; name: string; models: Array<{ alias: string; id: string }> }> }) {
  const [mode, setMode] = useState<'text2video' | 'image2video'>('text2video')
  const [channelId, setChannelId] = useState(props.channels[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [image, setImage] = useState('')
  const [negative, setNegative] = useState('')
  const [aspect, setAspect] = useState('16:9')
  const [duration, setDuration] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenerateResult | undefined>()
  const [error, setError] = useState('')
  const channel = props.channels.find(entry => entry.id === channelId) ?? props.channels[0]

  const run = async (enhance: boolean): Promise<void> => {
    if (prompt.trim() === '') {
      setError(tt('prompt.required'))
      return
    }
    setBusy(true)
    setError('')
    try {
      let finalPrompt = prompt.trim()
      if (enhance) {
        const enhanced = await props.api.enhancePrompt(finalPrompt)
        if (enhanced.ok && enhanced.enhanced !== undefined) finalPrompt = enhanced.enhanced
      }
      const out = await props.api.generate({
        mode,
        prompt: finalPrompt,
        ...(channelId === '' ? {} : { channelId }),
        ...(model === '' ? {} : { model }),
        ...(image.trim() === '' ? {} : { image: image.trim() }),
        ...(negative.trim() === '' ? {} : { negativePrompt: negative.trim() }),
        ...(aspect === '' ? {} : { aspectRatio: aspect }),
        ...(duration === '' ? {} : { duration: Number(duration) }),
        wait: true,
        waitSeconds: 240,
      })
      setResult(out)
      if (out.status === 'failed') setError(out.error ?? '')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <button className={mode === 'text2video' ? `${css.pill} ${css.pillActive}` : css.pill} onClick={() => setMode('text2video')}>{tt('mode.text2video')}</button>
        <button className={mode === 'image2video' ? `${css.pill} ${css.pillActive}` : css.pill} onClick={() => setMode('image2video')}>{tt('mode.image2video')}</button>
      </div>
      <div className={css.row}>
        <select className={css.select} value={channelId} onChange={event => setChannelId(event.target.value)}>
          {props.channels.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <select className={css.select} value={model} onChange={event => setModel(event.target.value)}>
          <option value="">{tt('model.label')}</option>
          {(channel?.models ?? []).map(entry => <option key={entry.id} value={entry.alias}>{entry.alias}</option>)}
        </select>
        <select className={css.select} value={aspect} onChange={event => setAspect(event.target.value)}>
          <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:3">4:3</option>
        </select>
        <input className={css.input} value={duration} onChange={event => setDuration(event.target.value.replace(/[^\d.]/g, ''))} placeholder={tt('duration.label')} />
      </div>
      <textarea className={css.textarea} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('prompt.placeholder')} />
      {mode === 'image2video' && (
        <input className={css.input} value={image} onChange={event => setImage(event.target.value)} placeholder={tt('image.placeholder')} />
      )}
      <input className={css.input} value={negative} onChange={event => setNegative(event.target.value)} placeholder={tt('negative.placeholder')} />
      <div className={css.row}>
        <button className={css.primary} disabled={busy} onClick={() => { void run(false) }}>{busy ? tt('generating') : tt('generate')}</button>
        <button className={css.secondary} disabled={busy} onClick={() => { void run(true) }}>{tt('enhance')}</button>
      </div>
      {error !== '' && <div className={css.error}>{error}</div>}
      {result !== undefined && <ResultView result={result} />}
      <TaskQuery api={props.api} channelId={channelId} />
    </div>
  )
}

function ResultView({ result }: { result: GenerateResult }) {
  if (result.status === 'completed') {
    return (
      <div className={css.result}>
        <div className={css.resultTitle}>{tt('result.done')}</div>
        {result.videos.map((video, index) => (
          <div key={index} className={css.mediaRow}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video className={css.video} src={video.url} controls preload="metadata" />
            <a className={css.link} href={video.url} download>{tt('download')}</a>
          </div>
        ))}
      </div>
    )
  }
  if (result.status === 'failed') {
    return <div className={css.error}>{tt('result.failed', { error: result.error ?? 'unknown' })}</div>
  }
  return <div className={css.pending}>{tt('result.pending', { id: result.taskId ?? '' })}</div>
}

function TaskQuery(props: { api: VideogenApi; channelId: string }) {
  const [taskId, setTaskId] = useState('')
  const [result, setResult] = useState<GenerateResult | undefined>()
  const [error, setError] = useState('')
  return (
    <div className={css.row}>
      <input className={css.input} value={taskId} onChange={event => setTaskId(event.target.value)} placeholder={tt('task.placeholder')} />
      <button
        disabled={taskId.trim() === ''}
        onClick={() => {
          void props.api.queryTask(taskId.trim(), props.channelId).then(setResult).catch((err: unknown) => setError(errorMessage(err)))
        }}
      >{tt('query')}</button>
      {error !== '' && <div className={css.error}>{error}</div>}
      {result !== undefined && <ResultView result={result} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Process                                                           */
/* ------------------------------------------------------------------ */

type ProcessActionName = 'info' | 'frames' | 'gif' | 'compress' | 'concat'

function ProcessView({ api }: { api: VideogenApi }) {
  const [action, setAction] = useState<ProcessActionName>('info')
  const [input, setInput] = useState('')
  const [inputs, setInputs] = useState('')
  const [count, setCount] = useState('4')
  const [at, setAt] = useState('')
  const [width, setWidth] = useState('')
  const [start, setStart] = useState('')
  const [duration, setDuration] = useState('')
  const [fps, setFps] = useState('10')
  const [transition, setTransition] = useState('0.5')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ProcessResult | undefined>()
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const out = await api.processRun({
        action,
        ...(input.trim() === '' ? {} : { input: input.trim() }),
        ...(inputs.trim() === '' ? {} : { inputs: inputs.split(',').map(item => item.trim()).filter(item => item !== '') }),
        ...(count === '' ? {} : { count: Number(count) }),
        ...(at === '' ? {} : { at: Number(at) }),
        ...(width === '' ? {} : { width: Number(width) }),
        ...(start === '' ? {} : { start: Number(start) }),
        ...(duration === '' ? {} : { duration: Number(duration) }),
        ...(fps === '' ? {} : { fps: Number(fps) }),
        ...(transition === '' ? {} : { transition: Number(transition) }),
      })
      setResult(out)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <select className={css.select} value={action} onChange={event => setAction(event.target.value as ProcessActionName)}>
          <option value="info">info</option><option value="frames">frames</option><option value="gif">gif</option><option value="compress">compress</option><option value="concat">concat</option>
        </select>
      </div>
      {action !== 'concat' && (
        <input className={css.input} value={input} onChange={event => setInput(event.target.value)} placeholder={tt('process.input')} />
      )}
      {action === 'concat' && (
        <textarea className={css.textarea} value={inputs} onChange={event => setInputs(event.target.value)} placeholder={tt('process.inputs')} />
      )}
      <div className={css.row}>
        {action === 'frames' && <input className={css.smallInput} value={count} onChange={event => setCount(event.target.value.replace(/[^\d]/g, ''))} placeholder={tt('process.count')} />}
        {action === 'frames' && <input className={css.smallInput} value={at} onChange={event => setAt(event.target.value.replace(/[^\d.]/g, ''))} placeholder={tt('process.at')} />}
        {(action === 'frames' || action === 'compress' || action === 'gif' || action === 'concat') && <input className={css.smallInput} value={width} onChange={event => setWidth(event.target.value.replace(/[^\d]/g, ''))} placeholder={tt('process.width')} />}
        {action === 'gif' && <input className={css.smallInput} value={start} onChange={event => setStart(event.target.value.replace(/[^\d.]/g, ''))} placeholder={tt('process.start')} />}
        {action === 'gif' && <input className={css.smallInput} value={duration} onChange={event => setDuration(event.target.value.replace(/[^\d.]/g, ''))} placeholder="duration" />}
        {action === 'gif' && <input className={css.smallInput} value={fps} onChange={event => setFps(event.target.value.replace(/[^\d]/g, ''))} placeholder={tt('process.fps')} />}
        {action === 'concat' && <input className={css.smallInput} value={transition} onChange={event => setTransition(event.target.value.replace(/[^\d.]/g, ''))} placeholder={tt('process.transition')} />}
      </div>
      <div className={css.row}>
        <button className={css.primary} disabled={busy} onClick={() => { void run() }}>{tt('process.run')}</button>
      </div>
      {error !== '' && <div className={css.error}>{error}</div>}
      {result !== undefined && <ProcessResultView result={result} />}
    </div>
  )
}

function ProcessResultView({ result }: { result: ProcessResult }) {
  if (result.info !== undefined) {
    return <pre className={css.pre}>{JSON.stringify(result.info, null, 2)}</pre>
  }
  if (result.frames !== undefined) {
    return (
      <div className={css.result}>
        <div className={css.frames}>
          {result.frames.map((frame, index) => (
            <img key={index} className={css.frame} src={frame.url} alt={`frame ${index}`} />
          ))}
        </div>
      </div>
    )
  }
  if (result.output !== undefined) {
    return (
      <div className={css.result}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className={css.video} src={result.output.url} controls preload="metadata" />
        <a className={css.link} href={result.output.url} download>{tt('download')}</a>
      </div>
    )
  }
  return <pre className={css.pre}>{JSON.stringify(result, null, 2)}</pre>
}

/* ------------------------------------------------------------------ */
/*  Studio                                                            */
/* ------------------------------------------------------------------ */

function StudioView(props: { api: VideogenApi; channels: Array<{ id: string; name: string }> }) {
  const [templates, setTemplates] = useState<StoryboardTemplate[]>([])
  const [projects, setProjects] = useState<StoryboardProject[]>([])
  const [selected, setSelected] = useState<StoryboardProject | undefined>()
  const [templateId, setTemplateId] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useMemo(() => async (): Promise<void> => {
    try {
      const [templatesList, projectsList] = await Promise.all([props.api.studioTemplates(), props.api.studioProjects()])
      setTemplates(templatesList)
      setProjects(projectsList)
      if (templateId === '' && templatesList.length > 0) setTemplateId(templatesList[0]!.id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [props.api, templateId])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedTemplate = templates.find(template => template.id === templateId)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const project = await props.api.studioCreate(templateId, `${selectedTemplate?.name ?? templateId}`, vars)
      setProjects(await props.api.studioProjects())
      setSelected(project)
      setMessage('created')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const open = async (id: string): Promise<void> => {
    const project = await props.api.studioGet(id)
    if (project !== undefined) setSelected(project)
  }

  const generateAll = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const out = await props.api.studioGenerateAll(selected.id, props.channels[0]?.id)
      setSelected(await props.api.studioGet(selected.id) ?? selected)
      const failed = out.results.filter(item => item.status === 'failed')
      setMessage(failed.length > 0 ? `failed: ${failed.map(item => item.error ?? item.shotId).join('; ')}` : 'done')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const compose = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError('')
    try {
      const out = await props.api.studioCompose(selected.id)
      if (out.ok && out.output !== undefined) {
        setSelected(await props.api.studioGet(selected.id) ?? selected)
        window.open(out.output.url, '_blank')
        setMessage('composed')
      } else {
        setError(out.message ?? 'compose failed')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <select className={css.select} value={templateId} onChange={event => {
          setTemplateId(event.target.value)
          const template = templates.find(item => item.id === event.target.value)
          const next: Record<string, string> = {}
          for (const variable of template?.variables ?? []) next[variable.key] = ''
          setVars(next)
        }}>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
        <button className={css.primary} disabled={busy} onClick={() => { void create() }}>{tt('studio.new')}</button>
      </div>
      {selectedTemplate !== undefined && (
        <div className={css.templateMeta}>
          <div>{selectedTemplate.description}</div>
          {(selectedTemplate.variables ?? []).map(variable => (
            <div className={css.row} key={variable.key}>
              <label className={css.label}>{variable.label}</label>
              <input className={css.input} value={vars[variable.key] ?? ''} onChange={event => setVars(prev => ({ ...prev, [variable.key]: event.target.value }))} placeholder={variable.hint ?? ''} />
            </div>
          ))}
        </div>
      )}
      {projects.length > 0 && (
        <div className={css.row}>
          <select className={css.select} value={selected?.id ?? ''} onChange={event => { void open(event.target.value) }}>
            <option value="">—</option>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
      )}
      {selected !== undefined && (
        <div className={css.shots}>
          <div className={css.shotHeader}>
            <span>{tt('studio.shots')}</span>
            <button className={css.secondary} disabled={busy} onClick={() => { void generateAll() }}>{tt('studio.generateAll')}</button>
            <button className={css.secondary} disabled={busy} onClick={() => { void compose() }}>{tt('studio.compose')}</button>
          </div>
          {selected.shots.map(shot => (
            <div key={shot.id} className={css.shot}>
              <div className={css.shotTitle}>
                {shot.name}
                <span className={shot.status === 'ready' ? css.badgeReady : shot.status === 'failed' ? css.badgeFailed : css.badgePending}>
                  {tt(`studio.${shot.status}` as never)}
                </span>
              </div>
              <div className={css.shotPrompt}>{shot.prompt}</div>
              {shot.error !== undefined && <div className={css.error}>{shot.error}</div>}
              {shot.videoUrl !== undefined && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video className={css.video} src={shot.videoUrl} controls preload="metadata" />
              )}
            </div>
          ))}
        </div>
      )}
      {message !== '' && <div className={css.info}>{message}</div>}
      {error !== '' && <div className={css.error}>{error}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Library                                                           */
/* ------------------------------------------------------------------ */

function LibraryView({ api }: { api: VideogenApi }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [error, setError] = useState('')
  const refresh = useMemo(() => async (): Promise<void> => {
    try {
      setEntries(await api.libraryList())
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <div className={css.section}>
      {entries.length === 0 && <div className={css.info}>{tt('library.empty')}</div>}
      {entries.map(entry => (
        <div key={entry.id} className={css.libraryEntry}>
          <div className={css.shotTitle}>{entry.name} <span className={css.badgePending}>{entry.type}</span></div>
          <div className={css.shotPrompt}>{entry.provenance.prompt ?? ''}</div>
          {entry.type === 'video' && entry.url !== undefined && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video className={css.video} src={entry.url} controls preload="metadata" />
          )}
          {entry.type === 'gif' && entry.url !== undefined && (
            <img className={css.frame} src={entry.url} alt={entry.name} />
          )}
        </div>
      ))}
      {error !== '' && <div className={css.error}>{error}</div>}
    </div>
  )
}
