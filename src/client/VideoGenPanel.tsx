/**
 * VideoGenPanel: the AI 视频 panel with four tabs (Generate / Process /
 * Studio / Library), rendered inside the center column like dsh-imagegen /
 * dsh-audiogen panels.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { VideogenApi } from './api.ts'
import type { VideogenScope, VideogenScopeSnapshot } from './settings-scope.ts'
import { tt, errorMessage } from './helpers.ts'
import type { GeneratedVideo, GenerateResult, LibraryEntry, ProcessRequest, ProcessResult, StoryboardProject, StoryboardTemplate } from '../protocol.ts'
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
  // The panel never locks the whole view on a missing channel config: only
  // generation-related actions need a channel, process / studio / library
  // keep working. A non-blocking banner + disabled buttons carry the hint.
  return (
    <div className={css.panel}>
      <div className={css.tabs}>
        {(['generate', 'process', 'studio', 'library'] as const).map(key => (
          <button key={key} className={tab === key ? `${css.tab} ${css.tabActive}` : css.tab} onClick={() => setTab(key)}>{tt(`tab.${key}` as never)}</button>
        ))}
      </div>
      {!haveChannels && <div className={css.banner}>{tt('config.missing')}</div>}
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

interface PanelTask {
  taskId: string
  prompt: string
  createdAt: number
  status: string
  videos: GeneratedVideo[]
  error?: string
}

function GenerateView(props: { api: VideogenApi; channels: Array<{ id: string; name: string; models: Array<{ alias: string; id: string }> }> }) {
  const [mode, setMode] = useState<'text2video' | 'image2video'>('text2video')
  const [channelId, setChannelId] = useState(props.channels[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [image, setImage] = useState('')
  const [negative, setNegative] = useState('')
  const [aspect, setAspect] = useState('16:9')
  const [duration, setDuration] = useState('')
  const [resolution, setResolution] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [tasks, setTasks] = useState<PanelTask[]>([])
  const [error, setError] = useState('')
  const channel = props.channels.find(entry => entry.id === channelId) ?? props.channels[0]

  // Poll every pending task (submit was wait:false → we drive progress here).
  useEffect(() => {
    const timer = setInterval(() => {
      setTasks(prev => {
        const pending = prev.filter(task => task.status !== 'completed' && task.status !== 'failed')
        if (pending.length === 0) return prev
        void Promise.all(pending.map(async task => {
          try {
            const out = await props.api.queryTask(task.taskId, channelId)
            if (out.status === 'completed' || out.status === 'failed') {
              setTasks(current => current.map(item => item.taskId === task.taskId
                ? { ...item, status: out.status, videos: out.videos ?? [], error: out.error }
                : item))
            }
          } catch {
            /* keep polling */
          }
        }))
        return prev
      })
    }, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api, channelId])

  const submit = async (): Promise<void> => {
    if (props.channels.length === 0) {
      setError(tt('config.missing'))
      return
    }
    if (prompt.trim() === '') {
      setError(tt('prompt.required'))
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const out = await props.api.generate({
        mode,
        prompt: prompt.trim(),
        ...(channelId === '' ? {} : { channelId }),
        ...(model === '' ? {} : { model }),
        ...(image.trim() === '' ? {} : { image: image.trim() }),
        ...(negative.trim() === '' ? {} : { negativePrompt: negative.trim() }),
        ...(aspect === '' ? {} : { aspectRatio: aspect }),
        ...(duration === '' ? {} : { duration: Number(duration) }),
        ...(resolution === '' ? {} : { resolution }),
        wait: false,
      })
      setTasks(prev => [{
        taskId: out.taskId ?? '',
        prompt: prompt.trim(),
        createdAt: Date.now(),
        status: out.status,
        videos: out.videos ?? [],
        ...(out.error !== undefined ? { error: out.error } : {}),
      }, ...prev].slice(0, 20))
      if (out.status === 'completed' && out.videos.length > 0 && out.taskId === '') {
        // synchronous gateway answer — nothing to poll
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const enhance = async (): Promise<void> => {
    if (prompt.trim() === '') {
      setError(tt('prompt.required'))
      return
    }
    try {
      const out = await props.api.enhancePrompt(prompt.trim())
      if (out.ok && out.enhanced !== undefined) setPrompt(out.enhanced)
      else if (out.message !== undefined) setError(out.message)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const forgetTask = (taskId: string): void => {
    setTasks(prev => prev.filter(task => task.taskId !== taskId))
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <button className={mode === 'text2video' ? `${css.pill} ${css.pillActive}` : css.pill} onClick={() => setMode('text2video')}>{tt('mode.text2video')}</button>
        <button className={mode === 'image2video' ? `${css.pill} ${css.pillActive}` : css.pill} onClick={() => setMode('image2video')}>{tt('mode.image2video')}</button>
      </div>
      <select className={css.select} value={channelId} onChange={event => setChannelId(event.target.value)}>
        {props.channels.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      <select className={css.select} value={model} onChange={event => setModel(event.target.value)}>
        <option value="">{tt('model.label')}</option>
        {(channel?.models ?? []).map(entry => <option key={entry.id} value={entry.alias}>{entry.alias}</option>)}
      </select>
      {mode === 'image2video' && (
        <input className={css.input} value={image} onChange={event => setImage(event.target.value)} placeholder={tt('image.placeholder')} />
      )}
      <textarea className={css.textarea} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={tt('prompt.placeholder')} />
      <div className={css.row}>
        <button className={css.primary} disabled={submitting || props.channels.length === 0} title={props.channels.length === 0 ? tt('config.missing') : undefined} onClick={() => { void submit() }}>{submitting ? tt('process.uploading') : tt('generate')}</button>
        <button className={css.secondary} disabled={props.channels.length === 0} title={props.channels.length === 0 ? tt('config.missing') : undefined} onClick={() => { void enhance() }}>{tt('enhance')}</button>
        <button className={css.secondary} onClick={() => setAdvanced(prev => !prev)}>{advanced ? tt('advanced.hide') : tt('advanced.show')}</button>
      </div>
      {advanced && (
        <div className={css.advancedBox}>
          <div className={css.row}>
            <select className={css.select} value={aspect} onChange={event => setAspect(event.target.value)}>
              <option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:3">4:3</option>
            </select>
            <input className={css.smallInput} value={duration} onChange={event => setDuration(event.target.value.replace(/[^\d.]/g, ''))} placeholder={tt('duration.label')} />
            <input className={css.smallInput} value={resolution} onChange={event => setResolution(event.target.value)} placeholder={tt('resolution.label')} />
          </div>
          <input className={css.input} value={negative} onChange={event => setNegative(event.target.value)} placeholder={tt('negative.placeholder')} />
        </div>
      )}
      {error !== '' && <div className={css.error}>{error}</div>}
      {tasks.length > 0 && (
        <div className={css.taskList} data-testid="generate-tasks">
          <div className={css.sectionTitle}>{tt('results.title', { count: tasks.length })}</div>
          {tasks.map(task => (
            <div key={task.taskId + task.prompt} className={css.taskCard}>
              <div className={css.taskHeader}>
                <span className={task.status === 'completed' ? css.badgeReady : task.status === 'failed' ? css.badgeFailed : css.badgeProcessing}>{tt(`task.state.${task.status}` as never)}</span>
                <span className={css.taskPrompt}>{task.prompt.slice(0, 60)}{task.prompt.length > 60 ? '…' : ''}</span>
                <button className={css.linkButton} onClick={() => forgetTask(task.taskId)}>{tt('channels.delete')}</button>
              </div>
              {task.status === 'completed' && <VideoGrid videos={task.videos} />}
              {task.status === 'failed' && <div className={css.error}>{task.error ?? tt('task.state.failed')}</div>}
              {task.status !== 'completed' && task.status !== 'failed' && (
                <div className={css.processingRow}><span className={css.spinner} />{tt('generating')}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function VideoGrid({ videos }: { videos: GeneratedVideo[] }) {
  if (videos.length === 0) return null
  return (
    <div className={css.videoGrid}>
      {videos.map((video, index) => (
        <div key={index + video.url} className={css.videoCard}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video className={css.video} src={video.url} controls preload="metadata" />
          <a className={css.link} href={video.url} download>{tt('download')}</a>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Process                                                           */
/* ------------------------------------------------------------------ */

type ProcessActionName = 'info' | 'frames' | 'gif' | 'compress' | 'concat'

function ProcessView({ api }: { api: VideogenApi }) {
  const [action, setAction] = useState<ProcessActionName>('info')
  const [source, setSource] = useState<'upload' | 'library' | 'manual'>('upload')
  const [input, setInput] = useState('')
  const [inputs, setInputs] = useState('')
  const [upload, setUpload] = useState<{ name: string; url: string; bytes: number } | undefined>()
  const [uploading, setUploading] = useState(false)
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [librarySel, setLibrarySel] = useState('')
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

  useEffect(() => {
    void api.libraryList()
      .then(entries => setLibrary(entries.filter(entry => entry.type === 'video' || entry.type === 'gif')))
      .catch(() => setLibrary([]))
  }, [api])

  const effectiveInput = source === 'upload'
    ? upload?.url ?? ''
    : source === 'library'
      ? library.find(entry => entry.id === librarySel)?.url ?? ''
      : input

  const pickFile = (file: File | undefined): void => {
    if (file === undefined) return
    setUploading(true)
    setError('')
    const reader = new FileReader()
    reader.onload = () => {
      void (async () => {
        try {
          const base64 = String(reader.result ?? '').split(',')[1] ?? ''
          const res = await api.uploadFile(file.name, base64)
          if (res.ok === true && res.url !== undefined) setUpload({ name: file.name, url: res.url, bytes: res.bytes ?? 0 })
          else setError(res.message ?? '上传失败')
        } catch (err) {
          setError(errorMessage(err))
        } finally {
          setUploading(false)
        }
      })()
    }
    reader.onerror = () => { setError('读取文件失败'); setUploading(false) }
    reader.readAsDataURL(file)
  }

  const run = async (): Promise<void> => {
    const target = effectiveInput
    const segmentInputs = inputs.split(',').map(item => item.trim()).filter(item => item !== '')
    let usedInputs: string[] | undefined = segmentInputs
    if (action === 'concat') {
      if (segmentInputs.length === 0 && target !== '') usedInputs = [target]
      if ((usedInputs?.length ?? 0) < 2) {
        setError('concat 至少需要 2 个片段：请从输入源选择或粘贴多个 URL/路径（逗号分隔）')
        return
      }
    } else if (target === '') {
      setError('请先上传文件、从资源库选择或手动输入视频地址')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload: ProcessRequest = {
        action,
        ...(action === 'concat' ? { inputs: usedInputs } : { input: target }),
        ...(count === '' ? {} : { count: Number(count) }),
        ...(at === '' ? {} : { at: Number(at) }),
        ...(width === '' ? {} : { width: Number(width) }),
        ...(start === '' ? {} : { start: Number(start) }),
        ...(duration === '' ? {} : { duration: Number(duration) }),
        ...(fps === '' ? {} : { fps: Number(fps) }),
        ...(transition === '' ? {} : { transition: Number(transition) }),
      }
      setResult(await api.processRun(payload))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{tt('process.inputSource')}</div>
      <div className={css.sourceTabs}>
        {(['upload', 'library', 'manual'] as const).map(key => (
          <button key={key} type="button" className={source === key ? `${css.sourceTab} ${css.sourceTabActive}` : css.sourceTab} onClick={() => setSource(key)}>{tt(`process.source.${key}` as never)}</button>
        ))}
      </div>
      {source === 'upload' && (
        <div>
          <label className={css.uploadBox}>
            <span>{uploading ? tt('process.uploading') : upload !== undefined ? upload.name : tt('process.uploadPick')}</span>
            <input type="file" accept="video/*,image/*" hidden onChange={event => { pickFile(event.target.files?.[0]); event.currentTarget.value = '' }} />
          </label>
          {upload !== undefined && (
            <div className={css.metaRow}>
              <span>{tt('process.uploadDone', { name: upload.name, mb: (upload.bytes / 1024 / 1024).toFixed(1) })}</span>
              <button type="button" className={css.linkButton} onClick={() => setUpload(undefined)}>{tt('channels.cancel')}</button>
            </div>
          )}
        </div>
      )}
      {source === 'library' && (
        <select className={css.select} value={librarySel} onChange={event => setLibrarySel(event.target.value)}>
          <option value="">{library.length === 0 ? tt('process.libraryEmpty') : tt('process.libraryPick')}</option>
          {library.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {(entry.provenance.prompt ?? '').slice(0, 40)}</option>)}
        </select>
      )}
      {source === 'manual' && (
        <input className={css.input} value={input} onChange={event => setInput(event.target.value)} placeholder={tt('process.inputHint')} />
      )}
      <div className={css.sectionTitle}>{tt('process.action')}</div>
      <div className={css.row}>
        <select className={css.select} value={action} onChange={event => setAction(event.target.value as ProcessActionName)}>
          <option value="info">info</option><option value="frames">frames</option><option value="gif">gif</option><option value="compress">compress</option><option value="concat">concat</option>
        </select>
      </div>
      {action === 'concat' && (
        <div>
          <textarea className={css.textarea} value={inputs} onChange={event => setInputs(event.target.value)} placeholder={tt('process.inputs')} />
          <p className={css.hintLine}>{tt('process.concatHint')}</p>
        </div>
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
        <button className={css.primary} disabled={busy || uploading} onClick={() => { void run() }}>{tt('process.run')}</button>
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
  const [dragIndex, setDragIndex] = useState<number | undefined>()
  const [compose, setCompose] = useState<{ status: 'running' | 'done' | 'failed'; output?: { file: string; url: string }; error?: string } | undefined>()

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

  // Poll an in-flight compose task.
  useEffect(() => {
    if (selected === undefined || compose === undefined || compose.status !== 'running') return
    const timer = setInterval(() => {
      void props.api.studioComposeStatus(selected.id).then(next => {
        if (next.status !== 'running') {
          setCompose(next.status === 'done' ? { status: 'done', output: next.output } : { status: 'failed', error: next.error })
        }
      }).catch(() => { /* keep polling */ })
    }, 2500)
    return () => clearInterval(timer)
  }, [props.api, selected, compose])

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
    setCompose(undefined)
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

  const startCompose = async (): Promise<void> => {
    if (selected === undefined) return
    setError('')
    setCompose({ status: 'running' })
    try {
      const out = await props.api.studioCompose(selected.id)
      if (out.ok !== true) {
        setCompose({ status: 'failed', error: out.message ?? 'compose failed' })
      }
    } catch (err) {
      setCompose({ status: 'failed', error: errorMessage(err) })
    }
  }

  const reorderShots = (from: number, to: number): void => {
    if (selected === undefined || from === to) return
    const shots = [...selected.shots]
    const [moved] = shots.splice(from, 1)
    shots.splice(to, 0, moved)
    const next = { ...selected, shots, updatedAt: Date.now() }
    setSelected(next)
    void props.api.studioUpdate(selected.id, undefined, { shots: next.shots }).then(project => setSelected(project)).catch(() => { /* keep local order */ })
  }

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{tt('studio.templates')}</div>
      <div className={css.templateGrid}>
        {templates.map(template => (
          <button key={template.id} type="button" className={templateId === template.id ? `${css.templateCard} ${css.templateCardActive}` : css.templateCard} onClick={() => {
            setTemplateId(template.id)
            const next: Record<string, string> = {}
            for (const variable of template.variables ?? []) next[variable.key] = ''
            setVars(next)
          }}>
            <span className={css.templateThumb} data-aspect={template.aspectRatio} data-template={template.id} />
            <span className={css.templateName}>{template.name}</span>
            <span className={css.templateMeta}>{template.shots.length} 镜头 · {template.duration}s · {template.aspectRatio}</span>
          </button>
        ))}
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
          <div className={css.row}>
            <button className={css.primary} disabled={busy || templates.length === 0} onClick={() => { void create() }}>{tt('studio.new')}</button>
          </div>
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
            <button className={css.secondary} disabled={busy || props.channels.length === 0} title={props.channels.length === 0 ? tt('config.missing') : undefined} onClick={() => { void generateAll() }}>{tt('studio.generateAll')}</button>
            <button className={css.secondary} disabled={busy || compose?.status === 'running'} onClick={() => { void startCompose() }}>{tt('studio.compose')}</button>
          </div>
          <p className={css.hintLine}>{tt('studio.dragHint')}</p>
          {selected.shots.map((shot, index) => (
            <div
              key={shot.id}
              className={dragIndex === index ? `${css.shot} ${css.shotDragging}` : css.shot}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={event => event.preventDefault()}
              onDrop={() => { reorderShots(dragIndex ?? index, index); setDragIndex(undefined) }}
              onDragEnd={() => setDragIndex(undefined)}
            >
              <div className={css.shotTitle}>
                <span className={css.dragHandle}>⋮⋮</span>
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
          {compose !== undefined && compose.status === 'running' && (
            <div className={css.composeRow}>
              <div className={css.progressBar}><span /></div>
              <span className={css.hintLine}>{tt('studio.composing')}</span>
            </div>
          )}
          {compose !== undefined && compose.status === 'done' && compose.output !== undefined && (
            <div className={css.result}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video className={css.video} src={compose.output.url} controls preload="metadata" />
              <a className={css.link} href={compose.output.url} download>{tt('download')}</a>
            </div>
          )}
          {compose !== undefined && compose.status === 'failed' && <div className={css.error}>{compose.error ?? 'compose failed'}</div>}
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
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [error, setError] = useState('')
  const [renamingId, setRenamingId] = useState<string | undefined>()
  const [renameValue, setRenameValue] = useState('')

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

  const filtered = entries.filter(entry => {
    if (typeFilter !== '' && entry.type !== typeFilter) return false
    if (keyword.trim() !== '') {
      const haystack = `${entry.name} ${(entry.tags ?? []).join(' ')} ${entry.category ?? ''} ${entry.provenance.prompt ?? ''} ${entry.provenance.model ?? ''}`.toLowerCase()
      if (!haystack.includes(keyword.trim().toLowerCase())) return false
    }
    return true
  })

  const rename = async (id: string): Promise<void> => {
    if (renameValue.trim() === '') return
    try {
      setEntries(await api.libraryUpdate(id, { name: renameValue.trim() }))
      setRenamingId(undefined)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      setEntries(await api.libraryDelete(id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <input className={css.input} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder={tt('library.search')} />
        <select className={css.select} style={{ flex: '0 0 auto' }} value={typeFilter} onChange={event => setTypeFilter(event.target.value)}>
          <option value="">{tt('library.type.all')}</option>
          <option value="video">video</option><option value="gif">gif</option><option value="image">image</option><option value="storyboard">storyboard</option>
        </select>
      </div>
      {filtered.length === 0 && <div className={css.info}>{keyword === '' && typeFilter === '' ? tt('library.empty') : tt('library.filterEmpty')}</div>}
      <div className={css.libraryGrid}>
        {filtered.map(entry => (
          <div key={entry.id} className={css.libraryCard}>
            <div className={css.libraryMedia}>
              {entry.type === 'image' && entry.url !== undefined && <img src={entry.url} alt={entry.name} />}
              {entry.type === 'gif' && entry.url !== undefined && <img src={entry.url} alt={entry.name} />}
              {(entry.type === 'video' || entry.type === 'storyboard') && entry.url !== undefined && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video className={css.video} src={entry.url} controls preload="metadata" />
              )}
            </div>
            <div className={css.libraryBody}>
              {renamingId === entry.id ? (
                <div className={css.row}>
                  <input className={css.input} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(entry.id) }} />
                  <button className={css.linkButton} onClick={() => { void rename(entry.id) }}>{tt('settings.save')}</button>
                  <button className={css.linkButton} onClick={() => setRenamingId(undefined)}>{tt('channels.cancel')}</button>
                </div>
              ) : (
                <div className={css.libraryName}>{entry.name} <span className={css.badgePending}>{entry.type}</span></div>
              )}
              {renamingId !== entry.id && (
                <div className={css.libraryOps}>
                  <button className={css.linkButton} onClick={() => { setRenamingId(entry.id); setRenameValue(entry.name) }}>{tt('library.rename')}</button>
                  <button className={css.linkButton} onClick={() => { void remove(entry.id) }}>{tt('channels.delete')}</button>
                </div>
              )}
              {entry.provenance.prompt !== undefined && <div className={css.shotPrompt}>{entry.provenance.prompt.slice(0, 80)}</div>}
            </div>
          </div>
        ))}
      </div>
      {error !== '' && <div className={css.error}>{error}</div>}
    </div>
  )
}
