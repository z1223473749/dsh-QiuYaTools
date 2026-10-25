import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Preferences } from '../../shared.ts'
import { ComputerIcon } from './presentation.tsx'
import { ComputerEnvironmentPanel, type ComputerEnvironmentStatus } from './environment-panel.tsx'

interface Connection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
const slot = 'conversation.input.left'
const names = { local: '这台电脑', browser: '独立浏览器', remote: '远端电脑' }

/** The public Session slot supplies the identity, including in detached chat
 * windows. Never resolve owner operations through the global selected seat. */
export function installChatComputerEnvironment(ctx: Context, form: ConfigForm<Preferences>): () => void {
  function Selector({ sessionId, useSession, useInput }: PropsRuntime<typeof slot>) {
    const preferences = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
    const enabled = preferences.status === 'ready' && preferences.value?.enabled !== false && preferences.value?.computerUseEnabled === true
    const locked = useSession(state => state.removed || state.subagent !== null || state.openState === 'loading' || state.openState === 'error')
    const submitting = useInput(state => state.phase === 'adjudicating' || state.phase === 'submitting')
    return <SessionEnvironment key={sessionId} sessionId={sessionId} enabled={enabled} disabled={locked || submitting}/>
  }
  function SessionEnvironment({ sessionId, enabled, disabled }: { sessionId: string; enabled: boolean; disabled: boolean }) {
    const [taskId, setTaskId] = useState<string>(), [creating, setCreating] = useState(false)
    const runtimeId = taskId ?? sessionId
    const [status, setStatus] = useState<ComputerEnvironmentStatus>({}), [error, setError] = useState(''), [open, setOpen] = useState(false)
    const root = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null)
    const mounted = useRef(true), generation = useRef(0), sequence = useRef(0), titleId = useId()
    const available = useRef(enabled && !disabled); available.current = enabled && !disabled
    const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, side: 'top', align: 'start', gap: 9, margin: 12 })
    useDismissOnOutsidePointer(root, open, setOpen, panel)
    const close = () => { setOpen(false); anchor.current?.focus() }
    const call = async (op: string, extra: object = {}, signal?: AbortSignal) => {
      if (!available.current || !mounted.current) throw new Error('当前会话暂不可选择操作环境。')
      const peer = ctx.get('connection') as Connection | undefined
      if (!peer) throw new Error('连接尚未就绪')
      const result = await peer.rpc.call('/api', 'qiuya-tools.computer.control', { ...(taskId ? { taskId } : {}), ...extra, op, sessionId }, signal)
      if (!result.ok) throw new Error(result.error?.message ?? '电脑操作环境暂不可用')
      return result.value
    }
    const refresh = async (signal?: AbortSignal) => {
      const revision = generation.current, request = ++sequence.current
      const result = await call('status', {}, signal) as ComputerEnvironmentStatus
      if (!mounted.current || !available.current || signal?.aborted || revision !== generation.current || request !== sequence.current) return
      setStatus(result); setError('')
    }
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
    useEffect(() => {
      generation.current++; setOpen(false); setError('')
      if (!enabled || disabled) return
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
      const poll = async () => {
        try { await refresh(controller.signal) } catch (failure) { if (!controller.signal.aborted && mounted.current) setError((failure as Error).message) }
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000)
      }
      void poll()
      return () => { controller.abort(); clearTimeout(timer) }
    }, [enabled, disabled, taskId])
    useEffect(() => {
      if (!open) return
      const document = anchor.current?.ownerDocument
      const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); close() } }
      document?.addEventListener('keydown', escape)
      panel.current?.focus()
      return () => document?.removeEventListener('keydown', escape)
    }, [open])
    if (!enabled || !sessionId) return null
    const connected = status.environments?.find(row => row.sessionId === runtimeId)
    const label = names[connected?.mode ?? 'local']
    return <div ref={root} className="qyt-computer-surface qyt-computer-environment" data-qyt-computer-environment={sessionId}>
      <button ref={anchor} type="button" className="qyt-computer-environment-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={`操作环境：${label}`} title="选择当前聊天的操作环境" onClick={() => setOpen(value => !value)}>
        <ComputerIcon/><span>{label}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open && !disabled && createPortal(<MenuSurface ref={panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} className="qyt-computer-surface qyt-computer-environment-popover" style={{ position: 'fixed', ...position, visibility: position ? undefined : 'hidden' }}>
        <div className="qyt-computer-environment-heading"><strong id={titleId}>操作环境</strong><button type="button" className="qyt-computer-environment-close" aria-label="关闭操作环境" onClick={close}>×</button></div>
        <p className="qyt-computer-environment-hint">仅用于当前聊天，其他任务不受影响。</p>
        <div className="qyt-computer-task-picker">
          <label>电脑任务<select aria-label="选择当前聊天的电脑任务" value={taskId ?? ''} disabled={creating} onChange={event => { generation.current++; setStatus(value => ({ ...value, native: undefined })); setTaskId(event.target.value || undefined) }}><option value="">默认任务</option>{status.tasks?.filter(task => task.chatSessionId === sessionId).map(task => <option key={task.taskId} value={task.taskId}>{task.taskLabel ?? '电脑任务'}</option>)}</select></label>
          <button type="button" className="qyt-button" disabled={creating || (status.tasks?.length ?? 0) >= 7} onClick={() => { if (creating) return; setCreating(true); void call('createTask').then(value => { const id = (value as { taskId?: string }).taskId; if (mounted.current && id) { generation.current++; setTaskId(id) } }).catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setCreating(false) }) }}>新建任务</button>
        </div>
        {error && <p className="qyt-computer-error" role="alert">{error}</p>}
        <ComputerEnvironmentPanel key={runtimeId} sessionId={runtimeId} enabled={enabled} disabled={disabled} status={status} call={call} onChanged={() => refresh()} onClose={close}/>
      </MenuSurface>, anchor.current?.ownerDocument.body ?? document.body)}
    </div>
  }
  return ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'qiuya-tools-computer-environment', order: 50 }, Selector))
}
