import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComputerAction } from '../computer-use/contract.ts'
import { ComputerIcon } from '../computer-use/presentation.tsx'
import type { WorkbenchAPI, WorkbenchFrame } from './client-api.ts'
import type { WorkbenchTarget, SiteRequest, SiteDecision } from './contract.ts'
import { website } from './contract.ts'
import { framePoint } from './preview-model.ts'
export function SiteApprovalCard({ request, busy, decide }: { request: SiteRequest; busy: boolean; decide(choice: SiteDecision): void }) {
  const expired = request.expiresAt <= Date.now()
  return <section className="qyt-computer-approval" aria-label="网站操作授权"><div className="qyt-computer-card-heading"><span className="qyt-feature-icon"><ComputerIcon/></span><div><strong>{request.origin}</strong><span className="qyt-computer-caption">{expired ? '请求已过期' : '需要你允许访问和操作这个网站'}</span></div></div><p>{request.reason}</p>{expired ? <p>请在聊天中重新提出这项任务。</p> : <div className="qyt-computer-actions"><button type="button" className="qyt-button qyt-button-primary" disabled={busy} onClick={() => decide('once')}>允许一次</button><button type="button" className="qyt-button" disabled={busy} onClick={() => decide('always')}>始终允许</button><button type="button" className="qyt-button" disabled={busy} onClick={() => decide('deny')}>拒绝</button></div>}<p className="qyt-computer-caption">仅授权这个网站来源；其他网站会另行询问。你可在设置中撤销持续许可。</p></section>
}
function useFrame(api: WorkbenchAPI, target: WorkbenchTarget | undefined, enabled: boolean, signal?: AbortSignal, active?: () => boolean) {
  const [frame, setFrame] = useState<WorkbenchFrame>(), [error, setError] = useState(''), [revision, setRevision] = useState(0), actionPending = useRef(false), generation = useRef(0), frameRef = useRef<WorkbenchFrame>(), lifetime = useRef<AbortController>(), frameVersion = useRef(0), blocked = useRef(false), gesturePending = useRef(false)
  useEffect(() => {
    const current = ++generation.current, controller = new AbortController(); lifetime.current = controller; frameRef.current = undefined; setFrame(undefined); setError(''); actionPending.current = false; gesturePending.current = false; blocked.current = false; frameVersion.current++
    if (!target || !enabled || signal?.aborted) return () => controller.abort()
    const scoped = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout>
    const valid = () => !scoped.aborted && generation.current === current && (!active || active())
    const poll = async () => {
      if (!valid() || blocked.current) return
      const before = frameVersion.current
      try { if (!actionPending.current && !gesturePending.current) { const value = await api.preview(target, scoped); if (!valid()) return; if (before === frameVersion.current && !actionPending.current && !gesturePending.current) { frameRef.current = value; setFrame(value); setError('') } } }
      catch { if (valid() && before === frameVersion.current && !actionPending.current && !gesturePending.current) { frameRef.current = undefined; setFrame(undefined); setError('画面暂不可用，请刷新检查当前任务。') } }
      if (valid()) timer = setTimeout(poll, 100)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer); frameRef.current = undefined; if (generation.current === current) generation.current++ }
  }, [api, target?.chatSessionId, target?.environmentId, target?.workbenchTabId, target?.epoch, enabled, signal, revision, active])
  const act = async (action: ComputerAction, acknowledged?: () => void) => {
    const current = generation.current, value = frameRef.current, controller = lifetime.current
    if (!controller || controller.signal.aborted || !value || value.viewOnly || actionPending.current || active && !active()) return
    actionPending.current = true; frameVersion.current++; frameRef.current = undefined; setError('')
    const scoped = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    try { await api.humanAct(value.target, value.observation.frameId, action, scoped); if (!scoped.aborted && current === generation.current) { acknowledged?.(); setRevision(v => v + 1) } }
    catch { if (!scoped.aborted && current === generation.current) { blocked.current = true; setFrame(undefined); setError('本次操作未能确认。请先刷新查看结果，不要重复提交。') } }
    finally { if (current === generation.current) actionPending.current = false }
  }
  return { frame, error, act, refresh: () => setRevision(v => v + 1), holdGesture: () => { gesturePending.current = true; frameVersion.current++ }, releaseGesture: () => { gesturePending.current = false }, setError }
}
/** Every gesture is scoped to the exact displayed frame. Closing/unmounting only cancels reads. */
export function WorkbenchSurface({ api, target, visible = true, signal, compact = false, active, onFrame, onActions }: { api: WorkbenchAPI; target?: WorkbenchTarget; visible?: boolean; signal?: AbortSignal; compact?: boolean; active?: () => boolean; onFrame?(frame: WorkbenchFrame): void; onActions?(actions: { act(action: ComputerAction): Promise<void>; refresh(): void }): void }) {
  const { frame, error, act, refresh, holdGesture, releaseGesture } = useFrame(api, target, visible, signal, active), image = useRef<HTMLImageElement>(null), stage = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 }), down = useRef<{ x: number; y: number; button: 'left' | 'right' | 'middle'; pointerId: number }>(), [text, setText] = useState(''), draftRevision = useRef(0), fit = compact ? 'fill' : 'contain'
  useEffect(() => { if (frame) onFrame?.(frame) }, [frame, onFrame])
  useEffect(() => { onActions?.({ act, refresh }) })
  useEffect(() => { down.current = undefined; releaseGesture() }, [target?.workbenchTabId, frame?.target.epoch, frame?.viewOnly, frame?.observation.width, frame?.observation.height, frame?.observation.geometry.x, frame?.observation.geometry.y, frame?.observation.geometry.width, frame?.observation.geometry.height, frame?.observation.geometry.scale])
  useLayoutEffect(() => { if (!stage.current) return; const element = stage.current, measure = () => { const r = element.getBoundingClientRect(); setSize({ width: r.width, height: r.height }) }; measure(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined; observer?.observe(element); window.addEventListener('resize', measure); return () => { observer?.disconnect(); window.removeEventListener('resize', measure) } }, [])
  const point = (x: number, y: number) => frame && image.current ? framePoint({ x, y }, image.current.getBoundingClientRect(), frame.observation, fit) : null
  const cursor = frame?.observation.aiCursor, showCursor = !frame?.viewOnly ? false : cursor?.visible && (cursor.epoch === undefined || cursor.epoch === frame.target.epoch)
  const imageScale = frame ? Math.min(size.width / frame.observation.width, size.height / frame.observation.height) : 0, displayWidth = compact ? size.width : (frame?.observation.width ?? 0) * imageScale, displayHeight = compact ? size.height : (frame?.observation.height ?? 0) * imageScale
  return <div className={'qyt-workbench-surface' + (compact ? ' qyt-workbench-surface-small' : '')} data-view-only={frame?.viewOnly !== false}>
    <div ref={stage} className="qyt-workbench-image-stage" tabIndex={frame?.viewOnly === false ? 0 : undefined} aria-label={frame?.viewOnly === false ? '已接管的实时画面，可点击或拖动' : '实时画面，仅预览'} onContextMenu={event => { if (frame?.viewOnly === false) event.preventDefault() }} onPointerDown={event => { if (frame?.viewOnly !== false || event.button < 0 || event.button > 2 || down.current) return; const p = point(event.clientX, event.clientY); if (!p) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId); holdGesture(); down.current = { ...p, pointerId: event.pointerId, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' } }} onPointerUp={event => { const start = down.current; down.current = undefined; releaseGesture(); if (!start || start.pointerId !== event.pointerId || frame?.viewOnly !== false) return; const end = point(event.clientX, event.clientY); event.currentTarget.releasePointerCapture?.(event.pointerId); if (!end) return; event.preventDefault(); const dragged = Math.abs(start.x - end.x) + Math.abs(start.y - end.y) > 4; void act(dragged ? { kind: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y, button: start.button } : { kind: 'click', x: start.x, y: start.y, button: start.button }) }} onPointerCancel={() => { down.current = undefined; releaseGesture() }} onLostPointerCapture={() => { down.current = undefined; releaseGesture() }} onWheel={event => { if (frame?.viewOnly !== false) return; const p = point(event.clientX, event.clientY); if (!p) return; event.preventDefault(); void act({ kind: 'scroll', ...p, deltaX: Math.max(-3000, Math.min(3000, event.deltaX)), deltaY: Math.max(-3000, Math.min(3000, event.deltaY)) }) }} onKeyDown={event => { if (frame?.viewOnly !== false || event.target !== event.currentTarget) return; if (event.key === 'Escape') return; const keys: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' }; const key = keys[event.key]; if (!key || event.ctrlKey || event.altKey || event.metaKey) return; event.preventDefault(); void act({ kind: 'key', key }) }}>
      {frame ? <img ref={image} draggable={false} alt="当前授权目标的实时画面" src={'data:image/jpeg;base64,' + frame.observation.imageBase64} style={{ objectFit: fit }} /> : <div className="qyt-workbench-placeholder" role="status"><ComputerIcon/><span>{error || '等待画面…'}</span></div>}
      {showCursor && cursor && <span className="qyt-workbench-cursor" aria-label="AI 鼠标指针" style={{ left: (size.width - displayWidth) / 2 + cursor.x / frame!.observation.width * displayWidth, top: (size.height - displayHeight) / 2 + cursor.y / frame!.observation.height * displayHeight }}><svg viewBox="0 0 18 20" aria-hidden="true"><path d="M3.1 2.4C2.3 2 1.6 2.6 1.8 3.5L4 16C4.2 17.1 5.4 17.3 6 16.3L9 11.4L14.4 9.1C15.5 8.7 15.6 7.4 14.5 6.9Z" fill="#95999e" fillOpacity=".45" stroke="white" strokeOpacity=".96" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round"/></svg></span>}
    </div>
    {!compact && frame?.viewOnly === false && <form className="qyt-workbench-input" onSubmit={event => { event.preventDefault(); if (!text) return; const value = text, revision = draftRevision.current; void act({ kind: 'type', text: value }, () => { if (draftRevision.current === revision) setText('') }) }}><input aria-label="向已接管窗口输入文字" placeholder="输入文字到当前窗口" value={text} maxLength={8000} onChange={event => { draftRevision.current++; setText(event.target.value) }}/><button type="submit" className="qyt-button" disabled={!text}>输入</button><button type="button" className="qyt-button" onClick={() => { void act({ kind: 'key', key: 'Enter' }) }}>Enter</button></form>}
    {error && frame && <p className="qyt-workbench-message" role="alert">{error}</p>}
    {!compact && <button className="qyt-workbench-refresh" type="button" onClick={refresh}>刷新画面</button>}
  </div>
}
export function NewWebsiteForm({ busy, onOpen, onCancel }: { busy: boolean; onOpen(url: string, browser: 'chrome' | 'edge', decision: 'once' | 'always'): Promise<void>; onCancel(): void }) {
  const [url, setUrl] = useState(''), [browser, setBrowser] = useState<'chrome' | 'edge'>(/Windows/iu.test(globalThis.navigator?.userAgent ?? '') ? 'edge' : 'chrome'), [decision, setDecision] = useState<'once' | 'always'>('once'), [error, setError] = useState('')
  let origin = ''; try { origin = website(url).origin } catch {}
  return <form className="qyt-workbench-new" aria-label="打开新网页" onSubmit={event => { event.preventDefault(); setError(''); try { const parsed = website(url); void onOpen(parsed.url, browser, decision).catch(() => setError('打开结果未能确认，请查看当前网页列表，不要重复提交。')) } catch { setError('请输入完整的 HTTP 或 HTTPS 网站地址。') } }}><strong>打开新网页</strong><input type="url" required aria-label="网站地址" placeholder="https://example.com" value={url} maxLength={8192} onChange={event => setUrl(event.target.value)}/><select aria-label="浏览器" value={browser} onChange={event => setBrowser(event.target.value as 'chrome' | 'edge')}><option value="chrome">Chrome</option><option value="edge">Edge</option></select><p>{origin ? <>允许模型在当前聊天中查看并操作 <strong>{origin}</strong>。</> : '填写网址后，确认这次任务允许访问的网站。'}</p><label><input type="radio" name="qyt-site-duration" value="once" checked={decision === 'once'} onChange={() => setDecision('once')}/>允许一次</label><label><input type="radio" name="qyt-site-duration" value="always" checked={decision === 'always'} onChange={() => setDecision('always')}/>始终允许这个网站</label><div className="qyt-computer-actions"><button className="qyt-button qyt-button-primary" disabled={busy || !origin} type="submit">允许并打开</button><button className="qyt-button" type="button" disabled={busy} onClick={onCancel}>取消</button></div>{error && <p role="alert">{error}</p>}</form>
}
export function WorkbenchIcon({ name }: { name: 'pages' | 'pause' | 'takeover' | 'resume' | 'stop' | 'open' | 'close' | 'inspect' | 'preview' }) {
  const shapes = {
    pages: <><rect x="7" y="7" width="14" height="14" rx="2.5"/><path d="M16 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/></>,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="2.8"/></>,
    takeover: <path d="m5 3 14 9-7 1-3 7-4-17Z"/>,
    resume: <path d="m8 5 11 7-11 7V5Z"/>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1.5"/>,
    open: <><path d="M14 3h7v7m0-7L11 13"/><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    inspect: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M10 7v4m0 2h.01"/></>,
    preview: <><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4"/></>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>
}
export function WorkbenchControls({ target, busy, control, open, choose, choices, compact = false, hide }: { target: WorkbenchTarget; busy: boolean; control(operation: 'pause' | 'takeover' | 'resume' | 'stop'): void; open?(): void; choose?(id: string): void; choices?: WorkbenchTarget[]; compact?: boolean; hide?(): void }) {
  const operations = [
    { operation: 'pause', label: '暂停', disabled: busy || !['ready', 'running'].includes(target.state) },
    { operation: 'takeover', label: '接管', disabled: busy || target.state === 'humanControl' },
    { operation: 'resume', label: '继续', disabled: busy || !['paused', 'humanControl'].includes(target.state) },
    { operation: 'stop', label: '停止', disabled: busy },
  ] as const
  const buttonClass = 'qyt-button' + (compact ? ' qyt-workbench-icon-button' : '')
  return <div className={'qyt-workbench-controls' + (compact ? ' qyt-workbench-controls-compact' : '')} aria-label="电脑预览悬浮控件">
    {choose && choices && choices.length > 1 && <span className={'qyt-button qyt-workbench-target-picker' + (compact ? ' qyt-workbench-icon-button' : '')} title={`切换预览任务（${choices.length} 个） · ${target.title || '未命名'}`}>
      <WorkbenchIcon name="pages"/>
      <select aria-label="选择预览任务" value={target.workbenchTabId} onChange={event => choose(event.target.value)}>{choices.map(view => <option key={view.workbenchTabId} value={view.workbenchTabId}>{view.kind === 'browser' ? '网页' : '桌面'} · {view.title || '未命名'}</option>)}</select>
    </span>}
    {operations.map(({ operation, label, disabled }) => <button key={operation} className={buttonClass} type="button" disabled={disabled} aria-label={compact ? `${label}电脑任务` : undefined} title={compact ? label : undefined} onClick={() => control(operation)}>{compact ? <WorkbenchIcon name={operation}/> : label}</button>)}
    {open && <button className={buttonClass} type="button" disabled={busy} aria-label={compact ? '弹出电脑预览' : undefined} title={compact ? '弹出' : undefined} onClick={open}>{compact ? <WorkbenchIcon name="open"/> : '弹出'}</button>}
    {hide && <button className={buttonClass} type="button" aria-label="关闭电脑预览" title="关闭预览（任务继续运行）" onClick={hide}><WorkbenchIcon name="close"/></button>}
  </div>
}
export function SitePermissions({ api }: { api: WorkbenchAPI }) {
  const [origins, setOrigins] = useState<string[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, refresh] = useState(0)
  useEffect(() => { const controller = new AbortController(); void api.permissions(controller.signal).then(value => { if (!controller.signal.aborted) { setOrigins(value); setError('') } }, () => { if (!controller.signal.aborted) setError('网站许可暂不可用，请刷新。') }); return () => controller.abort() }, [api, revision])
  return <section className="qyt-card qyt-computer-surface qyt-site-permissions" aria-label="始终允许的网站"><div className="qyt-computer-card-heading"><span className="qyt-feature-icon"><ComputerIcon/></span><div><strong>始终允许的网站</strong><p className="qyt-computer-caption">聊天中选择“始终允许”后会显示在这里。撤销会立即停止相关网页输入。</p></div></div>{origins.length ? origins.map(origin => <div className="qyt-computer-permission-row" key={origin}><span>{origin}</span><button type="button" className="qyt-button" disabled={busy} onClick={() => { setBusy(true); void api.revoke(origin, new AbortController().signal).then(() => refresh(v => v + 1), () => setError('撤销保存未能确认，请刷新检查；本次会话已停止使用该许可。')).finally(() => setBusy(false)) }}>撤销</button></div>) : <p className="qyt-computer-caption">还没有持续授权的网站。直接在聊天里提出浏览器任务即可。</p>}{error && <p role="alert">{error}</p>}<button type="button" className="qyt-button" disabled={busy} onClick={() => refresh(v => v + 1)}>刷新许可</button></section>
}
