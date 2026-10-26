import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { ComputerApprovalCard, ComputerIcon, SystemPermissionNotice, computerApprovalNeedsSystemPermissions, computerStateLabels, type ComputerApprovalRequest, type ComputerDecision, type NativeApplication, type ComputerNativeView } from './presentation.tsx'
import type { Context } from '@deepseek-ai/cordis'
import type { ComputerSessionSnapshot } from './contract.ts'
import { ApplicationIcon, ApplicationPicker } from './application-picker.tsx'

interface Rpc { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
interface Catalog { list: { getSnapshot(): { ids: string[]; byId: Record<string, { displayTitle?: string; title?: string; blank?: boolean; origin?: string }> } } }
const endpoint = 'qiuya-tools.computer.control'
type NativeView = ComputerNativeView
type Status = { sessions: ComputerSessionSnapshot[]; allowedApps: string[]; pendingRequests?: ComputerApprovalRequest[]; native: NativeView | null; environments?: { sessionId?: string; mode: 'local' | 'remote' | 'browser'; previewDetached?: boolean }[] }
const noSubscribe = () => () => {}
export function ComputerPanel({ ctx, enabled, onEnabled, disabled }: { ctx: Context; enabled: boolean; onEnabled(value: boolean): void; disabled: boolean }) {
  const currentSeat = (ctx.get('uiSession') as { adapter?: { current?: { subscribe(listener: () => void): () => void; getSnapshot(): { key?: string } } } } | undefined)?.adapter?.current
  const activeSessionId = useSyncExternalStore(currentSeat ? listener => currentSeat.subscribe(listener) : noSubscribe, () => currentSeat?.getSnapshot().key, () => undefined)
  const [status, setStatus] = useState<Status>({ sessions: [], allowedApps: [], native: null })
  const [message, setMessage] = useState(''), [statusError, setStatusError] = useState(''), [busy, setBusy] = useState(false)
  const [applications, setApplications] = useState<NativeApplication[]>([]), [addingApp, setAddingApp] = useState(false)
  const [applicationBusy, setApplicationBusy] = useState(false), applicationGeneration = useRef(0)
  const revision = useRef(0), mounted = useRef(true), performing = useRef(false)
  const statusRead = useRef<{ revision: number; result: Promise<void> } | undefined>(undefined)
  const applicationRead = useRef<Promise<NativeApplication[]> | undefined>(undefined)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++ } }, [])
  const call = async (op: string, extra: object = {}) => {
    const connection = ctx.get('connection') as Rpc | undefined
    if (!connection) throw new Error('连接尚未就绪')
    const response = await connection.rpc.call('/api', endpoint, { op, ...extra })
    if (!response.ok) throw new Error(response.error?.message ?? '电脑操控请求失败')
    return response.value
  }
  const refresh = () => {
    const generation = revision.current, current = statusRead.current
    // Slow native reads must survive later polling ticks. Explicit rechecks
    // share the current read, while a new seat/enablement revision owns its own.
    if (current?.revision === generation) return current.result
    const read = { revision: generation, result: Promise.resolve() }
    read.result = (async () => {
      const result = await call('status') as Status
      if (!mounted.current || generation !== revision.current || statusRead.current !== read) return
      setStatus(result); setStatusError('')
    })().catch(error => {
      if (mounted.current && generation === revision.current && statusRead.current === read) {
        setStatusError((error as Error).message)
        // A failed read cannot keep displaying a previous grant as a current
        // OS result. Retain only the environment identity, not stale bits.
        setStatus(previous => ({ ...previous, native: { available: false, platform: previous.native?.platform, mode: previous.native?.mode, message: '当前状态读取失败，恢复连接后会自动重新检查。' } }))
      }
      throw error
    }).finally(() => { if (statusRead.current === read) statusRead.current = undefined })
    statusRead.current = read
    return read.result
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
    // An asynchronous settings readback invalidates old replies but must not
    // erase the environment the owner has been preparing in the meantime.
    revision.current++; performing.current = false; setMessage(''); setStatusError(''); setBusy(false)
    let disposed = false
    const run = async () => { try { if (!disposed) await refresh() } catch {} }
    const onReturn = () => { if (enabled && document.visibilityState !== 'hidden') void run() }
    void run(); const timer = window.setInterval(() => { void run() }, 1500)
    window.addEventListener('focus', onReturn); document.addEventListener('visibilitychange', onReturn)
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', onReturn); document.removeEventListener('visibilitychange', onReturn) }
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
      }
      await refresh(); return true
    } catch (error) { if (op !== 'refresh' && mounted.current && generation === revision.current) setMessage((error as Error).message); return false }
    finally { if (mounted.current && generation === revision.current) { performing.current = false; setBusy(false) } }
  }
  const native = status.native, mac = native?.platform === 'darwin'
  const catalog = (ctx.get('sessions') as Catalog | undefined)?.list.getSnapshot()
  const tasks = status.sessions.filter(item => item.state !== 'stopped')
  const decide = (request: ComputerApprovalRequest, decision: ComputerDecision) => { void action('decide', { sessionId: request.sessionId, requestId: request.requestId, requestVersion: request.requestVersion, ...(request.taskId ? { taskId: request.taskId } : {}), decision }) }
  return <div className="qyt-feature-panel qyt-computer-surface qyt-computer-panel">
    <section className="qyt-card qyt-feature-summary">
      <div className="qyt-toggle-row"><div className="qyt-feature-heading"><span className="qyt-feature-icon"><ComputerIcon/></span><h3>电脑操控</h3></div><Switch className="qyt-switch" checked={enabled} disabled={disabled} label="启用电脑操控" onChange={onEnabled}/></div>
      <p className="qyt-muted">在聊天中说明任务，模型会自动请求所需应用。你确认授权后，它才会查看画面并开始操作。</p>
      <div className="qyt-computer-summary-meta"><span className="qyt-computer-status-badge">{enabled ? '已启用' : '未启用'}</span><span className="qyt-computer-caption">随时暂停、人工接管，或把预览弹出为独立窗口。</span></div>
    </section>
    {enabled && status.pendingRequests?.map(request => <div key={request.requestId}><SystemPermissionNotice native={request.preflight} busy={busy} onOpenSettings={kind => { void action('openSettings', { kind, sessionId: request.sessionId }) }} onRefresh={() => { void action('refresh') }}/><ComputerApprovalCard request={request} busy={busy} allowDisabled={computerApprovalNeedsSystemPermissions(request.preflight)} onDecision={decision => decide(request, decision)}/></div>)}
    <section className="qyt-card" aria-label="系统权限">
      <div className="qyt-computer-section-heading"><div><h4>系统权限</h4><p className="qyt-muted">{!enabled ? '启用电脑操控后，可检查并设置系统权限。' : mac ? '自动检测 macOS 权限，授权后返回这里会自动更新。' : '检查这台电脑的可用状态。应用授权会在聊天中单独询问。'}</p></div><button type="button" className="qyt-button" disabled={busy || !enabled} onClick={() => { void action('refresh') }}>重新检查</button></div>
      {enabled && statusError && <p className="qyt-computer-error" role="alert">{statusError}</p>}
      {!enabled ? null : mac ? <SystemPermissionNotice native={native} busy={busy} full onOpenSettings={kind => { void action('openSettings', { kind }) }} onRefresh={() => { void action('refresh') }}/>
        : <p className="qyt-muted">{native?.message || (native?.available ? '当前交互桌面已就绪。' : '正在检查本机状态…')}</p>}
    </section>
    <section className="qyt-card" aria-label="始终允许的应用">
      <div className="qyt-computer-section-heading"><div><h4>始终允许的应用</h4><p className="qyt-muted">这些应用无需重复询问。撤销后会立即停止相应操作。</p></div><button type="button" className="qyt-button" disabled={busy || applicationBusy || addingApp || !enabled} onClick={() => { void openApplications() }}>{applicationBusy ? '正在读取…' : '添加应用'}</button></div>
      {addingApp && enabled && <ApplicationPicker applications={applications} busy={busy} onCancel={() => setAddingApp(false)} onAllow={appId => { void action('allow', { appId, allowed: true }).then(accepted => { if (accepted) setAddingApp(false) }) }}/>}
      {status.allowedApps.length ? <div className="qyt-computer-permission-list">{status.allowedApps.map(id => <div className="qyt-computer-permission-row" key={id}><div className="qyt-computer-application-identity"><ApplicationIcon application={applications.find(app => app.appId === id)}/><div><strong>{applications.find(app => app.appId === id)?.name || id}</strong><span className="qyt-computer-caption">持续授权</span></div></div><button type="button" className="qyt-button" disabled={busy} aria-label={`撤销 ${applications.find(app => app.appId === id)?.name || id}`} onClick={() => { void action('allow', { appId: id, allowed: false }) }}>撤销</button></div>)}</div> : <p className="qyt-computer-empty">暂无持续授权。模型首次使用应用时会向你询问。</p>}
    </section>
    <section className="qyt-card" aria-label="电脑任务概览"><div className="qyt-computer-section-heading"><div><h4>任务概览</h4><p className="qyt-muted">同一聊天可同时保留多个任务，每个任务都有独立的预览、授权和暂停状态。</p></div><span className="qyt-computer-status-badge">{tasks.length} 个任务</span></div>
      {!tasks.length && <p className="qyt-computer-empty">还没有电脑任务。回到聊天，告诉模型你想完成什么。</p>}
      {tasks.map(task => <div key={task.sessionId} className="qyt-computer-task" data-qyt-computer-session={task.sessionId} data-state={task.state}><div className="qyt-computer-section-heading"><div><strong>{task.taskLabel ?? catalog?.byId[task.chatSessionId ?? task.sessionId]?.displayTitle ?? catalog?.byId[task.chatSessionId ?? task.sessionId]?.title ?? '聊天任务'}</strong><p className="qyt-computer-caption">{task.target?.title || '等待应用授权'}</p></div><span className="qyt-computer-status-badge">{computerStateLabels[task.state] ?? '需要处理'}</span></div><div className="qyt-computer-actions">
        <button type="button" className="qyt-button" disabled={busy} onClick={() => { void action(['paused', 'humanControl'].includes(task.state) ? 'resume' : 'pause', { sessionId: task.chatSessionId ?? task.sessionId, ...(task.taskId ? { taskId: task.taskId } : {}) }) }}>{['paused', 'humanControl'].includes(task.state) ? '继续' : '暂停'}</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('preview', { sessionId: task.chatSessionId ?? task.sessionId, ...(task.taskId ? { taskId: task.taskId } : {}) }) }}>弹出预览</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('redock', { sessionId: task.chatSessionId ?? task.sessionId, ...(task.taskId ? { taskId: task.taskId } : {}) }) }}>收回聊天</button><button type="button" className="qyt-button" disabled={busy} onClick={() => { void action('stop', { sessionId: task.chatSessionId ?? task.sessionId, ...(task.taskId ? { taskId: task.taskId } : {}) }) }}>停止</button>
      </div>{task.error && <p className="qyt-computer-error" role="status">{task.error.message}</p>}</div>)}
    </section>
    <p className="qyt-computer-settings-hint">在聊天输入框旁选择操作环境，默认使用这台电脑。独立浏览器和远端电脑也在会话中配置。</p>
    {message && <p className="qyt-computer-error" role="alert">{message}</p>}
  </div>
}
