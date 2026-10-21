import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Preferences } from '../../shared.ts'
import type { ComputerSessionSnapshot } from './contract.ts'

interface Connection { rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
interface PreviewStatus { sessions: ComputerSessionSnapshot[]; environments?: { sessionId: string; previewDetached?: boolean }[] }
const endpoint = 'qiuya-tools.computer.control'
const labels: Record<string, string> = { ready: '已就绪', running: '正在操作', paused: '已暂停', humanControl: '你正在接管', resuming: '正在继续', stopping: '正在停止', faulted: '需要处理', disconnected: '连接断开', connecting: '正在连接', pausing: '正在暂停', handingOver: '正在接管' }
export function inlineComputerPreviewUrl(sessionId: string): string { return `/api/qiuya-tools.computer.preview?session=${encodeURIComponent(sessionId)}&view=inline` }

/** An additive, Session-scoped public slot. Unmounting its iframe does not
 * revoke another background task; only explicit owner controls change input.
 */
export function installInlineComputerPreview(ctx: Context, form: ConfigForm<Preferences>): () => void {
  const connection = () => ctx.get('connection') as Connection | undefined
  function InlinePreview({ sessionId }: PropsRuntime<'conversation.session.header.utilities'>) {
    const preferences = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
    const enabled = preferences.status === 'ready' && preferences.value?.enabled !== false && preferences.value?.computerUseEnabled === true
    const [current, setCurrent] = useState<ComputerSessionSnapshot>(), [detached, setDetached] = useState(false)
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [collapsed, setCollapsed] = useState(false)
    const generation = useRef(0), refreshSequence = useRef(0), pending = useRef(false), mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
    const call = async (op: string, signal?: AbortSignal) => {
      const peer = connection(); if (!peer) throw new Error('连接尚未就绪')
      const result = await peer.rpc.call('/api', endpoint, { op, sessionId }, signal)
      if (!result.ok) throw new Error(result.error?.message ?? '电脑预览暂不可用')
      return result.value
    }
    const refresh = async (signal?: AbortSignal) => {
      const revision = generation.current, sequence = ++refreshSequence.current, status = await call('status', signal) as PreviewStatus
      if (!mounted.current || signal?.aborted || revision !== generation.current || sequence !== refreshSequence.current) return
      setCurrent(status.sessions.find(row => row.sessionId === sessionId))
      setDetached(status.environments?.find(row => row.sessionId === sessionId)?.previewDetached === true)
    }
    useEffect(() => {
      generation.current++; pending.current = false; setCurrent(undefined); setError(''); setDetached(false); setBusy(false)
      if (!enabled) return
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
      const poll = async () => {
        try { await refresh(controller.signal) } catch (failure) { if (!controller.signal.aborted && mounted.current) setError((failure as Error).message) }
        if (!controller.signal.aborted) timer = setTimeout(poll, 1200)
      }
      void poll()
      return () => { controller.abort(); clearTimeout(timer) }
    }, [enabled, sessionId])
    const control = async (op: string) => {
      if (pending.current) return
      pending.current = true
      const revision = generation.current; setBusy(true); setError('')
      try {
        await call(op)
        if (mounted.current && revision === generation.current) await refresh()
      } catch (failure) { if (mounted.current && revision === generation.current) setError((failure as Error).message) }
      finally { if (mounted.current && revision === generation.current) { pending.current = false; setBusy(false) } }
    }
    if (!enabled || !current || current.sessionId !== sessionId || current.state === 'stopped') return null
    const live = ['ready', 'running', 'paused', 'humanControl'].includes(current.state)
    return <div className="qyt-computer-inline-anchor" data-qyt-computer-chat={sessionId}>
      <button type="button" className="qyt-computer-inline-toggle" aria-label={collapsed ? '显示电脑实时预览' : '收起电脑实时预览'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>电脑 · {labels[current.state] ?? current.state}</button>
      {!collapsed && <section className="qyt-computer-inline-card" aria-label="电脑实时预览" data-qyt-computer-inline={sessionId}>
        <div className="qyt-computer-inline-title"><span title={current.target?.title}>{current.target?.title || '电脑操控'}</span><span>{labels[current.state] ?? current.state}</span></div>
        {detached ? <div className="qyt-computer-inline-detached">预览已弹出<button type="button" disabled={busy} onClick={() => { void control('redock') }}>收回到聊天</button></div>
          : live ? <iframe title="当前聊天的实时电脑画面" src={inlineComputerPreviewUrl(sessionId)} referrerPolicy="no-referrer" className="qyt-computer-inline-frame"/>
            : <div className="qyt-computer-inline-detached">{current.error?.message || '等待电脑画面'}</div>}
        <div className="qyt-computer-inline-actions">
          <button type="button" disabled={busy} aria-label="暂停电脑任务" onClick={() => { void control('pause') }}>暂停</button>
          <button type="button" disabled={busy || !live} aria-label="接管电脑任务" onClick={() => { void control('takeover') }}>接管</button>
          <button type="button" disabled={busy || !['paused', 'humanControl'].includes(current.state)} aria-label="继续电脑任务" onClick={() => { void control('resume') }}>继续</button>
          <button type="button" disabled={busy} aria-label="停止电脑任务" onClick={() => { void control('stop') }}>停止</button>
          <button type="button" disabled={busy || !live} aria-label={detached ? '收回电脑预览' : '弹出电脑预览'} onClick={() => { void control(detached ? 'redock' : 'preview') }}>{detached ? '收回' : '弹出'}</button>
        </div>
        {error && <p role="alert">{error}</p>}
      </section>}
    </div>
  }
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'qiuya-tools-computer-inline', order: 85 }, InlinePreview))
}
