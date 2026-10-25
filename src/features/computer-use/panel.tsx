import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ComputerApprovalCard, ComputerIcon, SystemPermissionNotice, computerApprovalNeedsSystemPermissions, computerStateLabels, type ComputerApprovalRequest, type ComputerDecision, type NativeApplication, type ComputerNativeView } from './presentation.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type { ComputerSessionSnapshot, NativeTarget } from './contract.ts'
import type { ExchangeFile, ExchangeRequest, ExchangeResult } from './exchange.ts'
import { ApplicationIcon, ApplicationPicker } from './application-picker.tsx'

interface Rpc { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
interface Catalog { list: { getSnapshot(): { ids: string[]; byId: Record<string, { displayTitle?: string; title?: string; blank?: boolean; origin?: string }> } } }
const endpoint = 'qiuya-tools.computer.control'
type NativeView = ComputerNativeView
type Status = { sessions: ComputerSessionSnapshot[]; allowedApps: string[]; pendingRequests?: ComputerApprovalRequest[]; native: NativeView | null; environments?: { sessionId?: string; mode: 'local' | 'remote' | 'browser'; previewDetached?: boolean }[] }
const noSubscribe = () => () => {}
const environmentName = { local: '这台电脑', remote: '独立电脑', browser: '独立浏览器' }
function FileExchangePanel({ call }: { call(op: string, extra?: object): Promise<unknown> }) {
  const [listing, setListing] = useState<ExchangeResult>(), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const request = async (value: ExchangeRequest) => await call('exchange', { request: value }) as ExchangeResult
  const refresh = async () => {
    const status = await request({ action: 'status' })
    const result = status.enabled ? await request({ action: 'list' }) : status
    if (mounted.current) setListing(result)
    return result
  }
  const upload = async (file: File) => {
    if (busy) return
    setBusy(true); setMessage('正在上传…'); let id: string | undefined, committed = false
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('单文件不能超过 8 MiB。')
      const bytes = new Uint8Array(await file.arrayBuffer()), digest = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (!mounted.current) throw new Error('文件交换面板已关闭。')
      const begun = await request({ action: 'begin', name: file.name, size: file.size, sha256 }); id = begun.id
      if (!id) throw new Error('远端没有返回上传标识。')
      for (let offset = 0; offset < bytes.length;) {
        if (!mounted.current) throw new Error('文件交换面板已关闭。')
        const chunk = bytes.subarray(offset, offset + 128 * 1024); let text = ''
        for (let start = 0; start < chunk.length; start += 8192) text += String.fromCharCode(...chunk.subarray(start, start + 8192))
        const result = await request({ action: 'chunk', id, offset, data: btoa(text) })
        if (result.offset !== offset + chunk.length) throw new Error('远端上传位置不一致，上传已取消。')
        offset += chunk.length
      }
      if (!mounted.current) throw new Error('文件交换面板已关闭。')
      const published = await request({ action: 'commit', id })
      if (published.done !== true || published.file?.name !== file.name || published.file.size !== file.size) throw new Error('远端未确认完整文件，请刷新列表检查，不要自动重传。')
      committed = true; await refresh()
      if (mounted.current) setMessage('文件已上传至远端专用交换目录。')
    } catch (error) { if (mounted.current) setMessage((error as Error).message) }
    finally {
      if (id && !committed) await request({ action: 'abort', id }).catch(() => {})
      if (mounted.current) setBusy(false)
    }
  }
  const download = async (file: ExchangeFile) => {
    if (busy) return
    setBusy(true); setMessage('正在下载…')
    try {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024) throw new Error('远端文件超过 8 MiB 限制。')
      const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0
      do {
        if (!mounted.current) throw new Error('文件交换面板已关闭。')
        const result = await request({ action: 'read', name: file.name, version: file.version, offset })
        if (typeof result.data !== 'string' || result.data.length > 174764 || result.file?.version !== file.version) throw new Error('远端下载数据无效。')
        const binary = atob(result.data), bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        if (bytes.length > 128 * 1024 || result.offset !== offset + bytes.length || result.offset > file.size || !bytes.length && !result.done) throw new Error('下载位置或分块大小无效。')
        offset = result.offset; chunks.push(bytes)
        if (result.done) { if (offset !== file.size) throw new Error('下载大小不一致。'); break }
      } while (offset < file.size)
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' })), anchor = document.createElement('a')
      anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000)
      if (mounted.current) setMessage('文件已交给本机浏览器下载。')
    } catch (error) { if (mounted.current) setMessage((error as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <div className="qyt-card"><h4>手动文件交换</h4><p className="qyt-muted">仅操作远端代理管理者明确启用的专用目录。单文件最多 8 MiB，不覆盖同名文件；不分享本机文件路径，也不给聊天模型文件操作能力。</p>
    <button className="qyt-button" disabled={busy} onClick={() => { setBusy(true); setMessage(''); void refresh().catch(error => setMessage(error.message)).finally(() => setBusy(false)) }}>检查并刷新交换目录</button>
    {listing && !listing.enabled && <p>远端尚未开启文件交换。请由代理管理者设置 QIUYA_COMPUTER_EXCHANGE_DIR 为专用真实目录后重启代理。</p>}
    {listing?.enabled && <><label>选择本机文件并上传 <input type="file" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file) }}/></label>
      {listing.files?.map(file => <p key={file.name}>{file.name} · {file.size} 字节 <button className="qyt-button" disabled={busy} onClick={() => { void download(file) }}>下载</button></p>)}
      {!listing.files?.length && <p>专用目录暂无可交换的普通文件。</p>}{listing.truncated && <p>列表最多显示 100 个文件；请由目录管理者整理后刷新。</p>}
    </>}{message && <p role="status">{message}</p>}
  </div>
}
export function ComputerPanel({ ctx, enabled, onEnabled, disabled }: { ctx: Context; enabled: boolean; onEnabled(value: boolean): void; disabled: boolean }) {
  const currentSeat = (ctx.get('uiSession') as { adapter?: { current?: { subscribe(listener: () => void): () => void; getSnapshot(): { key?: string } } } } | undefined)?.adapter?.current
  const activeSessionId = useSyncExternalStore(currentSeat ? listener => currentSeat.subscribe(listener) : noSubscribe, () => currentSeat?.getSnapshot().key, () => undefined)
  const [status, setStatus] = useState<Status>({ sessions: [], allowedApps: [], native: null })
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [fileGeneration, setFileGeneration] = useState(0)
  const [applications, setApplications] = useState<NativeApplication[]>([]), [addingApp, setAddingApp] = useState(false)
  const [applicationBusy, setApplicationBusy] = useState(false), applicationGeneration = useRef(0)
  const [mode, setMode] = useState<'local' | 'remote' | 'browser'>('local'), [endpointUrl, setEndpointUrl] = useState(''), [token, setToken] = useState(''), [allowPrivate, setAllowPrivate] = useState(false)
  const [browser, setBrowser] = useState<'chrome' | 'edge'>('chrome'), [origins, setOrigins] = useState(''), [initialUrl, setInitialUrl] = useState(''), [cdpEndpoint, setCdpEndpoint] = useState('')
  const revision = useRef(0), mounted = useRef(true), performing = useRef(false), refreshSequence = useRef(0)
  const applicationRead = useRef<Promise<NativeApplication[]> | undefined>(undefined)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++ } }, [])
  const call = async (op: string, extra: object = {}) => {
    const connection = ctx.get('connection') as Rpc | undefined
    if (!connection) throw new Error('连接尚未就绪')
    const response = await connection.rpc.call('/api', endpoint, { op, ...extra })
    if (!response.ok) throw new Error(response.error?.message ?? '电脑操控请求失败')
    return response.value
  }
  const refresh = async () => {
    const generation = revision.current, sequence = ++refreshSequence.current, result = await call('status') as Status
    if (!mounted.current || generation !== revision.current || sequence !== refreshSequence.current) return
    setStatus(result)
  }
  const loadApplications = () => {
    if (!applicationRead.current) {
      const pending = call('applications') as Promise<NativeApplication[]>
      applicationRead.current = pending
      void pending.finally(() => { if (applicationRead.current === pending) applicationRead.current = undefined }).catch(() => {})
    }
    return applicationRead.current
  }
  useEffect(() => {
    // Credentials and browser targets belong to this chat. Retain the chosen
    // mode so invalidating a draft cannot turn Remote Connect into Local.
    setToken(''); setEndpointUrl(''); setAllowPrivate(false)
    setOrigins(''); setInitialUrl(''); setCdpEndpoint('')
  }, [activeSessionId])
  useEffect(() => {
    // An asynchronous settings readback invalidates old replies but must not
    // erase the environment the owner has been preparing in the meantime.
    revision.current++; performing.current = false; setMessage(''); setBusy(false); setFileGeneration(value => value + 1)
    let disposed = false
    const run = async () => { try { if (!disposed) await refresh() } catch (error) { if (!disposed) setMessage((error as Error).message) } }
    void run(); const timer = window.setInterval(() => { void run() }, 1500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [enabled, activeSessionId])
  useEffect(() => {
    applicationGeneration.current++; setApplicationBusy(false); setAddingApp(false)
    if (!enabled) return
    let disposed = false
    // Application names are owner-only metadata; loading them never opens a
    // control session or the manual add form. Keep identities if discovery fails.
    void loadApplications().then(result => { if (!disposed && mounted.current) setApplications(result) }).catch(() => {})
    return () => { disposed = true }
  }, [enabled])
  const openApplications = async () => {
    if (busy || applicationBusy || addingApp || !enabled) return
    const generation = ++applicationGeneration.current
    setApplicationBusy(true); setMessage('')
    try {
      const list = await loadApplications()
      if (mounted.current && generation === applicationGeneration.current) { setApplications(list); setAddingApp(true) }
    } catch (error) { if (mounted.current && generation === applicationGeneration.current) setMessage((error as Error).message) }
    finally { if (mounted.current && generation === applicationGeneration.current) setApplicationBusy(false) }
  }
  const action = async (op: string, extra: object = {}) => {
    if (performing.current) return
    performing.current = true; const generation = revision.current; setBusy(true); setMessage('')
    try {
      if (op !== 'refresh') {
        await call(op, extra)
        if (!mounted.current || generation !== revision.current) return
        if (op === 'connect') setFileGeneration(value => value + 1)
      }
      await refresh(); return true
    } catch (error) { if (mounted.current && generation === revision.current) setMessage((error as Error).message); return false }
    finally { if (mounted.current && generation === revision.current) { performing.current = false; setBusy(false) } }
  }
  const native = status.native, mac = native?.platform === 'darwin'
  const catalog = (ctx.get('sessions') as Catalog | undefined)?.list.getSnapshot()
  const tasks = status.sessions.filter(item => item.state !== 'stopped')
  const connected = status.environments?.find(item => item.sessionId === activeSessionId)
  const decide = (request: ComputerApprovalRequest, decision: ComputerDecision) => { void action('decide', { sessionId: request.sessionId, requestId: request.requestId, requestVersion: request.requestVersion, decision }) }
  return <div className="qyt-feature-panel qyt-computer-surface qyt-computer-panel">
    <section className="qyt-card qyt-feature-summary">
      <div className="qyt-toggle-row"><div className="qyt-feature-heading"><span className="qyt-feature-icon"><ComputerIcon/></span><h3>电脑操控</h3></div><Switch className="qyt-switch" checked={enabled} disabled={disabled} label="启用电脑操控" onChange={onEnabled}/></div>
      <p className="qyt-muted">在聊天中说明任务，模型会自动请求所需应用。你确认授权后，它才会查看画面并开始操作。</p>
      <div className="qyt-computer-summary-meta"><span className="qyt-computer-status-badge">{enabled ? '已启用' : '未启用'}</span><span className="qyt-computer-caption">随时暂停、人工接管，或把预览弹出为独立窗口。</span></div>
    </section>
    {enabled && status.pendingRequests?.map(request => <div key={request.requestId}><SystemPermissionNotice native={request.preflight} busy={busy} onOpenSettings={kind => { void action('openSettings', { kind, sessionId: request.sessionId }) }} onRefresh={() => { void action('refresh') }}/><ComputerApprovalCard request={request} busy={busy} allowDisabled={computerApprovalNeedsSystemPermissions(request.preflight)} onDecision={decision => decide(request, decision)}/></div>)}
    <section className="qyt-card" aria-label="系统权限">
      <div className="qyt-computer-section-heading"><div><h4>系统权限</h4><p className="qyt-muted">{!enabled ? '启用电脑操控后，可检查并设置系统权限。' : mac ? '授权在系统设置中完成，返回后重新检查即可。' : '检查这台电脑的可用状态。应用授权会在聊天中单独询问。'}</p></div><button type="button" className="qyt-button" disabled={busy || !enabled} onClick={() => { void action('refresh') }}>重新检查</button></div>
      {!enabled ? null : mac ? <SystemPermissionNotice native={native} busy={busy} full onOpenSettings={kind => { void action('openSettings', { kind }) }} onRefresh={() => { void action('refresh') }}/>
        : <p className="qyt-muted">{native?.message || (native?.available ? '当前交互桌面已就绪。' : '正在检查本机状态…')}</p>}
    </section>
    <section className="qyt-card" aria-label="始终允许的应用">
      <div className="qyt-computer-section-heading"><div><h4>始终允许的应用</h4><p className="qyt-muted">这些应用无需重复询问。撤销后会立即停止相应操作。</p></div><button type="button" className="qyt-button" disabled={busy || applicationBusy || addingApp || !enabled} onClick={() => { void openApplications() }}>{applicationBusy ? '正在读取…' : '添加应用'}</button></div>
      {addingApp && enabled && <ApplicationPicker applications={applications} busy={busy} onCancel={() => setAddingApp(false)} onAllow={appId => { void action('allow', { appId, allowed: true }).then(accepted => { if (accepted) setAddingApp(false) }) }}/>}
      {status.allowedApps.length ? <div className="qyt-computer-permission-list">{status.allowedApps.map(id => <div className="qyt-computer-permission-row" key={id}><div className="qyt-computer-application-identity"><ApplicationIcon application={applications.find(app => app.appId === id)}/><div><strong>{applications.find(app => app.appId === id)?.name || id}</strong><span className="qyt-computer-caption">持续授权</span></div></div><button type="button" className="qyt-button" disabled={busy} aria-label={`撤销 ${applications.find(app => app.appId === id)?.name || id}`} onClick={() => { void action('allow', { appId: id, allowed: false }) }}>撤销</button></div>)}</div> : <p className="qyt-computer-empty">暂无持续授权。模型首次使用应用时会向你询问。</p>}
    </section>
    <section className="qyt-card" aria-label="电脑任务概览"><div className="qyt-computer-section-heading"><div><h4>任务概览</h4><p className="qyt-muted">每个聊天都有独立的预览、授权和暂停状态。</p></div><span className="qyt-computer-status-badge">{tasks.length} 个任务</span></div>
      {!tasks.length && <p className="qyt-computer-empty">还没有电脑任务。回到聊天，告诉模型你想完成什么。</p>}
      {tasks.map(task => <div key={task.sessionId} className="qyt-computer-task" data-qyt-computer-session={task.sessionId} data-state={task.state}><div className="qyt-computer-section-heading"><div><strong>{catalog?.byId[task.sessionId]?.displayTitle ?? catalog?.byId[task.sessionId]?.title ?? '聊天任务'}</strong><p className="qyt-computer-caption">{task.target?.title || '等待应用授权'}</p></div><span className="qyt-computer-status-badge">{computerStateLabels[task.state] ?? '需要处理'}</span></div><div className="qyt-computer-actions">
        <button type="button" className="qyt-button" disabled={busy} onClick={() => { void action(['paused', 'humanControl'].includes(task.state) ? 'resume' : 'pause', { sessionId: task.sessionId }) }}>{['paused', 'humanControl'].includes(task.state) ? '继续' : '暂停'}</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('preview', { sessionId: task.sessionId }) }}>弹出预览</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('redock', { sessionId: task.sessionId }) }}>收回聊天</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('stop', { sessionId: task.sessionId }) }}>停止</button>
      </div>{task.error && <p className="qyt-computer-error" role="status">{task.error.message}</p>}</div>)}
    </section>
    <details className="qyt-card qyt-computer-advanced"><summary>高级操作环境<span>独立浏览器、虚拟机与远端电脑</span></summary><p className="qyt-muted">日常使用无需配置。{activeSessionId ? '以下环境仅用于当前聊天，不影响其他任务。' : '进入聊天后可为该聊天配置独立环境。'}</p><div className="qyt-computer-fields">
      <label>操作环境<select value={mode} onChange={event => { setMode(event.target.value as typeof mode); setFileGeneration(value => value + 1) }}><option value="local">这台电脑</option><option value="remote">独立虚拟机或远端电脑</option><option value="browser">浏览器专用通道</option></select></label>
      {mode === 'remote' && <><label>配对地址<input type="url" value={endpointUrl} placeholder="https://computer.example/v1/computer" onChange={event => setEndpointUrl(event.target.value)}/></label><label>配对密钥<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label><label className="qyt-computer-check"><input type="checkbox" checked={allowPrivate} onChange={event => setAllowPrivate(event.target.checked)}/>允许连接受信任的私有网络</label></>}
      {mode === 'browser' && <><label>浏览器<select value={browser} onChange={event => setBrowser(event.target.value as typeof browser)}><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select></label><label>允许的网站来源（每行一个）<textarea rows={3} value={origins} placeholder="https://example.com" onChange={event => setOrigins(event.target.value)}/></label><label>起始页面<input type="url" value={initialUrl} placeholder="https://example.com/" onChange={event => setInitialUrl(event.target.value)}/></label><details><summary>连接现有浏览器</summary><label>本机调试地址（可选）<input type="url" value={cdpEndpoint} placeholder="http://127.0.0.1:9222" onChange={event => setCdpEndpoint(event.target.value)}/></label></details><p className="qyt-muted">默认打开独立浏览器配置，只访问你列出的网站。</p></>}
      <div className="qyt-computer-actions"><button type="button" className="qyt-button" disabled={busy || !enabled || !activeSessionId || mode === 'remote' && (!endpointUrl || !token) || mode === 'browser' && !origins.trim()} onClick={() => { void action('connect', { sessionId: activeSessionId, mode, endpoint: endpointUrl, token, allowPrivateNetwork: allowPrivate, browser, allowedOrigins: origins.split(/[\n,]+/u).map(value => value.trim()).filter(Boolean), initialUrl: initialUrl || undefined, cdpEndpoint: cdpEndpoint || undefined }) }}>连接当前聊天的环境</button>{connected && <span className="qyt-computer-caption">已连接：{environmentName[connected.mode]}</span>}</div>
      {enabled && mode === 'remote' && (activeSessionId ? connected?.mode === 'remote' : native?.mode === 'remote') && !busy && <FileExchangePanel key={`${activeSessionId ?? ''}:${fileGeneration}`} call={(op, extra) => call(op, { ...(activeSessionId ? { sessionId: activeSessionId } : {}), ...extra })}/>}
    </div></details>
    {message && <p className="qyt-computer-error" role="alert">{message}</p>}
  </div>
}
