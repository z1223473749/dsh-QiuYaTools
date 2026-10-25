import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Preferences } from '../../shared.ts'
import type { ComputerSessionSnapshot } from './contract.ts'
import { ComputerApprovalCard, SystemPermissionNotice, computerApprovalNeedsSystemPermissions, type ComputerApprovalRequest, type ComputerDecision, type ComputerNativeView } from './presentation.tsx'

interface Connection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
interface PreviewStatus { sessions: ComputerSessionSnapshot[]; pendingRequests?: ComputerApprovalRequest[]; native?: ComputerNativeView | null; environments?: { sessionId: string; previewDetached?: boolean }[] }
const endpoint = 'qiuya-tools.computer.control'
export { clampInlinePreviewPosition } from './inline-bounds.ts'
import { isComputerTaskForChat } from './task-types.ts'
import { inlinePreviewLayout, observeInlinePreviewLayout } from './inline-bounds.ts'
export function inlineComputerPreviewUrl(sessionId: string, taskId?: string): string { return `/api/qiuya-tools.computer.preview?session=${encodeURIComponent(sessionId)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}&view=inline` }

/** An additive, Session-scoped public slot. Unmounting its iframe does not
 * revoke another background task; only explicit owner controls change input.
 */
export function installInlineComputerPreview(ctx: Context, form: ConfigForm<Preferences>): () => void {
  const connection = () => ctx.get('connection') as Connection | undefined
  function InlinePreview({ sessionId }: PropsRuntime<'conversation.session.header.utilities'>) {
    const preferences = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
    const enabled = preferences.status === 'ready' && preferences.value?.enabled !== false && preferences.value?.computerUseEnabled === true
    const [native, setNative] = useState<ComputerNativeView | null>()
    const [requests, setRequests] = useState<ComputerApprovalRequest[]>([])
    const [tasks, setTasks] = useState<ComputerSessionSnapshot[]>([]), [selected, setSelected] = useState<string>(), [detachedTasks, setDetachedTasks] = useState<string[]>([])
    const current = tasks.find(row => row.sessionId === selected) ?? tasks[0]
    const detached = !!current && detachedTasks.includes(current.sessionId)
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [controlsHidden, setControlsHidden] = useState(false)
    const [position, setPosition] = useState<{ x: number; y: number }>(), [limits, setLimits] = useState<{ maxWidth: number; maxHeight: number }>(), [dragging, setDragging] = useState(false)
    const anchor = useRef<HTMLDivElement>(null), card = useRef<HTMLElement>(null), drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; handle: HTMLElement }>()
    const generation = useRef(0), refreshSequence = useRef(0), pending = useRef(false), mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
    const call = async (op: string, signal?: AbortSignal, extra: object = {}) => {
      const peer = connection(); if (!peer) throw new Error('连接尚未就绪')
      const result = await peer.rpc.call('/api', endpoint, Object.fromEntries(Object.entries({ op, sessionId, ...extra }).filter(([, value]) => value !== undefined)), signal)
      if (!result.ok) throw new Error(result.error?.message ?? '电脑预览暂不可用')
      return result.value
    }
    const refresh = async (signal?: AbortSignal) => {
      const revision = generation.current, sequence = ++refreshSequence.current, status = await call('status', signal) as PreviewStatus
      if (!mounted.current || signal?.aborted || revision !== generation.current || sequence !== refreshSequence.current) return
      setNative(status.native)
      setTasks(status.sessions.filter(row => isComputerTaskForChat(row, sessionId) && row.state !== 'stopped'))
      setRequests((status.pendingRequests ?? []).filter(row => row.sessionId === sessionId && row.state === 'pending'))
      setDetachedTasks((status.environments ?? []).filter(row => row.previewDetached).map(row => row.sessionId))
    }
    useEffect(() => {
      generation.current++; pending.current = false; setTasks([]); setSelected(undefined); setNative(undefined); setRequests([]); setError(''); setDetachedTasks([]); setBusy(false)
      if (!enabled) return
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
      const poll = async () => {
        try { await refresh(controller.signal) } catch (failure) { if (!controller.signal.aborted && mounted.current) setError((failure as Error).message) }
        if (!controller.signal.aborted) timer = setTimeout(poll, 1200)
      }
      void poll()
      return () => { controller.abort(); clearTimeout(timer) }
    }, [enabled, sessionId])
    const control = async (op: string, extra: object = {}) => {
      if (pending.current) return
      pending.current = true
      const revision = generation.current; setBusy(true); setError('')
      try {
        if (op !== 'refresh') await call(op, undefined, { ...(current?.taskId ? { taskId: current.taskId } : {}), ...extra })
        if (mounted.current && revision === generation.current) await refresh()
      } catch (failure) { if (mounted.current && revision === generation.current) setError((failure as Error).message) }
      finally { if (mounted.current && revision === generation.current) { pending.current = false; setBusy(false) } }
    }
    const active = current && isComputerTaskForChat(current, sessionId) && current.state !== 'stopped' ? current : undefined
    const live = !!active && ['ready', 'running', 'paused', 'humanControl'].includes(active.state)
    const cancelDrag = () => {
      const previous = drag.current; drag.current = undefined
      if (previous?.handle.hasPointerCapture?.(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId)
      if (mounted.current) setDragging(false)
    }
    const clamp = (point: { x: number; y: number }) => anchor.current ? inlinePreviewLayout(anchor.current, card.current, sessionId, point) : point
    useLayoutEffect(() => { cancelDrag(); setPosition(undefined); setLimits(undefined); setControlsHidden(false) }, [sessionId])
    useLayoutEffect(() => {
      if (!enabled || (!active && !requests.length) || !card.current) return
      const view = card.current.ownerDocument.defaultView ?? window
      const contain = () => { if (!anchor.current || !card.current) return; const origin = anchor.current.getBoundingClientRect(), box = card.current.getBoundingClientRect(); setPosition(previous => { const next = inlinePreviewLayout(anchor.current!, card.current, sessionId, previous ?? { x: origin.right - (box.width || 300), y: origin.bottom + 10 }); return previous?.x === next.x && previous.y === next.y ? previous : { x: next.x, y: next.y } }); const next = inlinePreviewLayout(anchor.current, card.current, sessionId, { x: 0, y: 0 }); setLimits(previous => previous?.maxWidth === next.maxWidth && previous.maxHeight === next.maxHeight ? previous : { maxWidth: next.maxWidth, maxHeight: next.maxHeight }) }
      contain(); const remove = observeInlinePreviewLayout(anchor.current!, card.current, sessionId, contain); view.addEventListener('blur', cancelDrag)
      return () => { remove(); view.removeEventListener('blur', cancelDrag); cancelDrag() }
    }, [enabled, sessionId, active?.sessionId, requests.length])
    useLayoutEffect(() => { if (active?.state === 'humanControl') cancelDrag() }, [active?.state])
    const startDrag = (event: React.PointerEvent<HTMLElement>) => {
      if (!active || event.button !== 0 || event.isPrimary === false || !card.current) return
      event.preventDefault(); event.stopPropagation()
      const box = card.current.getBoundingClientRect()
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: position?.x ?? box.left, top: position?.y ?? box.top, handle: event.currentTarget }
      event.currentTarget.setPointerCapture?.(event.pointerId); setDragging(true)
    }
    const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
      const start = drag.current
      if (!start || start.pointerId !== event.pointerId) return
      event.preventDefault(); setPosition(clamp({ x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y }))
    }
    const nudge = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key]
      if (!direction || !card.current) return
      event.preventDefault(); const box = card.current.getBoundingClientRect(), step = event.shiftKey ? 40 : 8
      setPosition(clamp({ x: (position?.x ?? box.left) + direction[0] * step, y: (position?.y ?? box.top) + direction[1] * step }))
    }
    if (!enabled || (!requests.length && !active)) return null
    const decide = (request: ComputerApprovalRequest, decision: ComputerDecision) => { void control('decide', { requestId: request.requestId, requestVersion: request.requestVersion, ...(request.taskId ? { taskId: request.taskId } : { taskId: undefined }), decision }) }
    return <div ref={anchor} className="qyt-computer-inline-anchor qyt-computer-surface" data-qyt-computer-chat={sessionId}>
      {(requests.length > 0 || active) && <section ref={card} className="qyt-computer-inline-card" aria-label="电脑实时预览" data-qyt-computer-inline={sessionId} data-task-count={tasks.length} data-qyt-computer-task={active?.taskId ?? sessionId} data-state={active?.state ?? 'awaitingPermission'} data-target-id={active?.target?.id} data-has-approval={requests.length > 0} data-dragging={dragging} data-controls-hidden={controlsHidden} style={{ ...limits, visibility: limits && (!limits.maxWidth || !limits.maxHeight) ? 'hidden' : undefined, ...(position ? { position: 'fixed', left: position.x, top: position.y, right: 'auto' } : {}) }} onPointerEnter={event => { if (event.buttons === 0) setControlsHidden(false) }} onPointerMove={moveDrag} onPointerUp={cancelDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
        {requests.map(request => {
          const preflight = request.preflight ?? native
          return <React.Fragment key={request.requestId}>
            <SystemPermissionNotice native={preflight} busy={busy} onOpenSettings={kind => { void control('openSettings', { kind }) }} onRefresh={() => { void control('refresh') }}/>
            <ComputerApprovalCard request={request} busy={busy} allowDisabled={computerApprovalNeedsSystemPermissions(preflight)} onDecision={decision => decide(request, decision)}/>
          </React.Fragment>
        })}
        {active && <div className="qyt-computer-inline-image">
          <div className="qyt-computer-inline-actions" aria-label="电脑预览悬浮控件" onFocusCapture={() => setControlsHidden(false)}>
            <button type="button" className="qyt-computer-inline-grip" aria-label="拖动电脑小预览" title="拖动小预览；方向键移动" onPointerDown={startDrag} onKeyDown={nudge}><svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><circle cx="5" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg></button>
            <button type="button" disabled={busy} aria-label="暂停电脑任务" onClick={() => { void control('pause') }}>暂停</button>
            <button type="button" disabled={busy || !live} aria-label="接管电脑任务" onClick={() => { void control('takeover') }}>接管</button>
            <button type="button" disabled={busy || !['paused', 'humanControl'].includes(active.state)} aria-label="继续电脑任务" onClick={() => { void control('resume') }}>继续</button>
            <button type="button" disabled={busy} aria-label="停止电脑任务" onClick={() => { void control('stop') }}>停止</button>
            <button type="button" disabled={busy || !live} aria-label={detached ? '收回电脑预览' : '弹出电脑预览'} onClick={() => { void control(detached ? 'redock' : 'preview') }}>{detached ? '收回' : '弹出'}</button>
            <button type="button" className="qyt-computer-inline-collapse" aria-label="隐藏预览控件" title="隐藏控件以操作完整画面；鼠标移出再进入或用 Tab 恢复" onClick={event => { event.currentTarget.blur(); setControlsHidden(true) }}>−</button>
          </div>
          {live ? <iframe key={active.sessionId} title="当前聊天的实时电脑画面" src={inlineComputerPreviewUrl(sessionId, active.taskId)} referrerPolicy="no-referrer" className="qyt-computer-inline-frame"/>
              : <div className="qyt-computer-inline-detached">{active.error?.message || '等待电脑画面'}</div>}
          {active.state !== 'humanControl' && <div className="qyt-computer-inline-drag-surface" aria-hidden="true" onPointerDown={startDrag}/>}
          {tasks.length > 1 && <div className="qyt-computer-inline-tasks" role="tablist" aria-label="当前聊天的电脑任务" onPointerDown={event => event.stopPropagation()}>
            {tasks.map((task, index) => <button key={task.sessionId} type="button" role="tab" aria-selected={task.sessionId === active.sessionId} aria-label={`切换电脑任务 ${index + 1}：${task.taskLabel ?? task.target?.title ?? '默认任务'}`} title={task.taskLabel ?? task.target?.title ?? '默认任务'} disabled={busy} onClick={() => { cancelDrag(); setSelected(task.sessionId); setControlsHidden(false); setError('') }}><span/>{index + 1}</button>)}
          </div>}

        </div>}
        {error && <p role="alert">{error}</p>}
      </section>}
    </div>
  }
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'qiuya-tools-computer-inline', order: 85 }, InlinePreview))
}
