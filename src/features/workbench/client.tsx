import { createPortal } from 'react-dom'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Preferences } from '../../shared.ts'
import type { ComputerAction } from '../computer-use/contract.ts'
import type { WorkbenchTarget } from './contract.ts'
import { workbenchAddress, parseWorkbenchAddress, website } from './contract.ts'
import { createWorkbenchAPI } from './client-api.ts'
import type { WorkbenchAPI, WorkbenchConnection, WorkbenchStatus, WorkbenchFrame } from './client-api.ts'
import { createWorkbenchResourceProvider, WorkbenchRefreshBus } from './resources.ts'
import { WorkbenchSurface, WorkbenchControls, SiteApprovalCard, NewWebsiteForm } from './Views.tsx'
import { workbenchFloatRect } from './float-layout.ts'
import { workbenchStyles } from './styles.ts'
import type { SessionBinding, ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAnnotationAPI } from '../annotations/client-api.ts'
import type { AnnotationAPI } from '../annotations/client-api.ts'
import { AnnotationEditorSession } from '../annotations/session.ts'
import { AnnotationSessionView } from '../annotations/SessionView.tsx'
import { inlinePreviewBounds, inlinePreviewLayout, observeInlinePreviewLayout } from '../computer-use/inline-bounds.ts'
import { ComputerApprovalCard, SystemPermissionNotice, computerApprovalNeedsSystemPermissions } from '../computer-use/presentation.tsx'
import type { ComputerApprovalRequest, ComputerNativeView, ComputerDecision } from '../computer-use/presentation.tsx'
interface Face { form: ConfigForm<Preferences>; api: WorkbenchAPI; annotations: AnnotationAPI; binding(chat: string): SessionBinding | undefined; current(chat: string): boolean; open(view: WorkbenchTarget): void; refresh(address: string): void; float(id: Parameters<Context['sidebarRight']['float']>[0]): void; dock(id: Parameters<Context['sidebarRight']['dock']>[0]): void; split(id: Parameters<Context['sidebarRight']['split']>[0]): void }
const TAB_ID = 'qiuya-tools.workbench'
const viewIdentity = (target: WorkbenchTarget) => [target.chatSessionId, target.environmentId, target.workbenchTabId, target.targetId, target.appId].join('\0')
/** Shared only by the installed API and exact root chat. Frames remain independent. */
interface ReadFence { key: string; target: WorkbenchTarget; settled: boolean; removeAbort(): void }
const controlReadScopes = new WeakMap<WorkbenchAPI, Map<string, ReturnType<typeof createControlReads>>>()
function createControlReads() {
  const controllers = new Map<string, AbortController>(), blocked = new Map<string, ReadFence>(), confirmed = new Map<string, { floor: number; target?: WorkbenchTarget }>(), listeners = new Set<() => void>()
  let revision = 0, serial = 0
  const notify = () => { serial++; for (const listener of listeners) listener() }
  const readable = (target: WorkbenchTarget) => { const key = viewIdentity(target), known = confirmed.get(key); return !blocked.has(key) && (!known || !!known.target && target.epoch >= known.target.epoch) }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) { revision++; for (const controller of controllers.values()) controller.abort(); controllers.clear(); for (const fence of blocked.values()) { fence.removeAbort(); fence.settled = true } } } },
    snapshot: () => serial,
    revision: () => revision,
    readable,
    // Resource updates may have been issued before control, even with a larger epoch.
    // Only an independently confirmed status can revive this exact view afterwards.
    target(target: WorkbenchTarget) { const known = confirmed.get(viewIdentity(target)); return known ? known.target : target },
    retired(target: WorkbenchTarget) { const known = confirmed.get(viewIdentity(target)); return !!known && !known.target },
    pending: () => blocked.size > 0,
    needsStatus(target: WorkbenchTarget) { return blocked.get(viewIdentity(target))?.settled === true },
    signal(target: WorkbenchTarget) { const key = viewIdentity(target); let controller = controllers.get(key); if (!controller || controller.signal.aborted && readable(target)) { controller = new AbortController(); controllers.set(key, controller) }; if (!readable(target)) controller.abort(); return controller.signal },
    block(target: WorkbenchTarget, signal: AbortSignal) {
      const key = viewIdentity(target), fence: ReadFence = { key, target, settled: false, removeAbort() {} }
      const abandoned = () => { if (blocked.get(key) === fence && !fence.settled) { fence.settled = true; revision++; notify() } }
      fence.removeAbort = () => signal.removeEventListener('abort', abandoned)
      signal.addEventListener('abort', abandoned, { once: true }); revision++; blocked.set(key, fence); controllers.get(key)?.abort(); notify(); return fence
    },
    settle(fence: ReadFence, stopped = false) { if (blocked.get(fence.key) !== fence) return; fence.removeAbort(); fence.settled = true; revision++; if (stopped) confirmed.set(fence.key, { floor: fence.target.epoch }); notify() },
    accept(version: number, targets: readonly WorkbenchTarget[]) {
      if (version !== revision) return false
      let changed = false
      const keys = new Set([...confirmed.keys(), ...blocked.keys()])
      for (const key of keys) {
        const fence = blocked.get(key); if (fence && !fence.settled) continue
        const fresh = targets.find(target => viewIdentity(target) === key), previous = confirmed.get(key), next = { floor: Math.max(previous?.floor ?? 0, fence?.target.epoch ?? 0, fresh?.epoch ?? 0), target: fresh }
        if (JSON.stringify(previous) !== JSON.stringify(next)) { confirmed.set(key, next); changed = true }
      }
      for (const [key, fence] of blocked) if (fence.settled) { fence.removeAbort(); controllers.delete(key); blocked.delete(key); changed = true }
      const live = new Set(targets.map(viewIdentity)); for (const [key, controller] of controllers) if (!live.has(key)) { controller.abort(); controllers.delete(key) }
      if (changed) notify(); return true
    },
    disable() { revision++; for (const controller of controllers.values()) controller.abort(); controllers.clear(); for (const fence of blocked.values()) { fence.removeAbort(); fence.settled = true }; notify() },
  }
}
function useControlReads(chat: string, enabled: boolean, api: WorkbenchAPI) {
  const reads = useMemo(() => { let chats = controlReadScopes.get(api); if (!chats) { chats = new Map(); controlReadScopes.set(api, chats) }; let reads = chats.get(chat); if (!reads) { reads = createControlReads(); chats.set(chat, reads) }; return reads }, [chat, api])
  useSyncExternalStore(reads.subscribe, reads.snapshot, reads.snapshot)
  useEffect(() => { if (!enabled) reads.disable() }, [reads, enabled])
  return reads
}
export function WorkbenchTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'>) { const info = props.useTabInfo(), parsed = parseWorkbenchAddress(info.tab.navigation.address), resource = props.useResource<'qiuya-workbench'>(info.tab.navigation.address); const value = resource.status === 'live' ? resource.value : undefined, target = parsed?.chatSessionId === props.sessionId && value?.target.chatSessionId === props.sessionId ? value.target : undefined; return <span className="qyt-workbench-tab-label" data-state={target?.state}><i aria-hidden="true"/>{target ? (target.kind === 'browser' ? '网页 · ' : '桌面 · ') + (target.title || '未命名') : '电脑工作台'}</span> }
export function WorkbenchTab(props: PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<Face>) {
  const preferences = useSyncExternalStore(listener => props.form.subscribe(listener), () => props.form.getSnapshot(), () => props.form.getSnapshot()), enabled = preferences.status === 'ready' && preferences.value?.enabled !== false && preferences.value?.computerUseEnabled === true
  const info = props.useTabInfo(), address = info.tab.navigation.address, parsed = parseWorkbenchAddress(address), resource = props.useResource<'qiuya-workbench'>(address), [annotation, setAnnotation] = useState<AnnotationEditorSession>(), [openingAnnotation, setOpeningAnnotation] = useState(false), annotationRef = useRef<AnnotationEditorSession>(), annotationOpening = useRef(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [newPage, setNewPage] = useState(false), [live, setLive] = useState<WorkbenchTarget>(), [readReady, setReadReady] = useState(true), [readCheck, recheckRead] = useState(0), [verified, setVerified] = useState<{ key: string; floor: number; target?: WorkbenchTarget }>(), [navigation, setNavigation] = useState<{ canGoBack: boolean; canGoForward: boolean; url?: string }>(), [addressDraft, setAddressDraft] = useState(''), editingAddress = useRef(false), surface = useRef<{ act(action: ComputerAction): Promise<void>; refresh(): void }>(), pendingMutation = useRef(false), verifyControl = useRef<() => Promise<void>>()
  const reads = useControlReads(props.sessionId, enabled, props.api)
  const value = resource.status === 'live' ? resource.value : undefined, resourceTarget = parsed?.chatSessionId === props.sessionId && value?.target.chatSessionId === props.sessionId ? value.target : undefined, sharedTarget = resourceTarget ? reads.target(resourceTarget) : undefined, confirmed = sharedTarget && verified?.key === viewIdentity(sharedTarget) && sharedTarget.epoch <= verified.floor ? verified : undefined, target = confirmed ? confirmed.target : sharedTarget, selected = live && target && viewIdentity(live) === viewIdentity(target) && live.epoch >= target.epoch ? live : target
  const current = useCallback(() => enabled && readReady && props.current(props.sessionId) && info.tab.visible && !info.tab.signal.aborted, [enabled, readReady, props.current, props.sessionId, info.tab.visible, info.tab.signal])
  useEffect(() => info.tab.actions.bindCommands({ refresh: () => { props.refresh(address); void verifyControl.current?.() } }), [info.tab.actions.bindCommands, props.refresh, address])
  useEffect(() => { setLive(undefined); setVerified(undefined); verifyControl.current = undefined; setAnnotation(undefined); setOpeningAnnotation(false); setError(''); setNewPage(false); setBusy(false); pendingMutation.current = false; setNavigation(undefined); setAddressDraft('') }, [address, info.tab.navigation.revision, enabled])
  const lifetime = useRef<AbortController>(); useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort() }, [address, info.tab.navigation.revision, props.sessionId, enabled])
  useEffect(() => {
    if (!enabled) { setReadReady(false); return }
    if (readReady) return
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, info.tab.signal]), version = reads.revision()
    void props.api.status(props.sessionId, signal).then(status => {
      if (signal.aborted || !props.current(props.sessionId) || !info.tab.visible || !reads.accept(version, status.views)) return
      if (resourceTarget) { const fresh = status.views.find(view => viewIdentity(view) === viewIdentity(resourceTarget)); setVerified({ key: viewIdentity(resourceTarget), floor: Math.max(resourceTarget.epoch, fresh?.epoch ?? 0), target: fresh }) }
      setReadReady(true)
    }, () => { if (!signal.aborted) setError('当前状态未能确认，请刷新状态后再继续。') })
    return () => controller.abort()
  }, [enabled, readReady, readCheck, props.api, props.current, props.sessionId, info.tab.visible, info.tab.signal, address, info.tab.navigation.revision, reads])
  useEffect(() => () => { const previous = annotationRef.current; annotationRef.current = undefined; void previous?.dispose().catch(() => {}); annotationOpening.current = false }, [address, info.tab.navigation.revision, props.sessionId, enabled])
  const closeAnnotation = useCallback(() => { const previous = annotationRef.current; annotationRef.current = undefined; setAnnotation(undefined); void previous?.dispose().catch(() => setError('批注画面的清理尚未确认，请退出这个专用浏览器后再试。')) }, [])
  const openAnnotation = async () => {
    if (!selected || annotationOpening.current || annotationRef.current || pendingMutation.current || !current() || !lifetime.current) return
    annotationOpening.current = true; setOpeningAnnotation(true); setError(''); surface.current = undefined
    const signal = AbortSignal.any([lifetime.current.signal, info.tab.signal])
    try { const editor = await AnnotationEditorSession.open({ api: props.annotations, target: selected, currentChat: () => current() ? props.sessionId : undefined, binding: props.binding, signal }); if (signal.aborted || !current()) { await editor.dispose(); return }; annotationRef.current = editor; setAnnotation(editor) }
    catch { if (!signal.aborted && current()) setError('批注画面未能核验，请刷新当前视图后重试。') }
    finally { if (!signal.aborted && current()) { annotationOpening.current = false; setOpeningAnnotation(false) } }
  }
  const editingAnnotation = !!annotation || openingAnnotation
  const mutate = async (operation: (signal: AbortSignal) => Promise<unknown>, controlled?: { target: WorkbenchTarget; operation: string }) => {
    if (annotationRef.current || annotationOpening.current || pendingMutation.current || !current() || !lifetime.current || controlled && !reads.readable(controlled.target)) return
    pendingMutation.current = true; const controller = lifetime.current, signal = AbortSignal.any([controller.signal, info.tab.signal]), fence = controlled ? reads.block(controlled.target, signal) : undefined
    setBusy(true); setError('')
    let controlConfirmed = false
    try { await operation(signal); if (!signal.aborted && current()) { controlConfirmed = true; if (controlled?.operation === 'stop') { setVerified({ key: viewIdentity(controlled.target), floor: controlled.target.epoch }); setLive(undefined) }; props.refresh(address) } }
    catch { if (!signal.aborted && current()) setError('操作结果未能确认。请刷新查看当前状态，不要重复提交。') }
    finally {
      if (!signal.aborted && current()) {
        if (fence && controlled) {
          reads.settle(fence, controlConfirmed && controlled.operation === 'stop')
          let checking = false
          const verify = async () => { if (checking) return; checking = true; const version = reads.revision(); try { const status = await props.api.status(props.sessionId, signal); if (signal.aborted || !current() || !reads.accept(version, status.views)) return; const fresh = status.views.find(view => viewIdentity(view) === viewIdentity(controlled.target)); setVerified({ key: viewIdentity(controlled.target), floor: Math.max(controlled.target.epoch, fresh?.epoch ?? 0), target: fresh }); setLive(undefined); verifyControl.current = undefined } catch { if (!signal.aborted && current()) setError(previous => previous || '当前状态未能确认，请刷新状态后再继续。') } finally { checking = false } }
          verifyControl.current = verify; await verify()
        }
        if (!signal.aborted && current()) { pendingMutation.current = false; setBusy(false) }
      }
    }
  }
  const readRevision = reads.snapshot()
  useEffect(() => {
    // A controller can live in the other entry, or disappear while its result is
    // unknown. Refresh only the exact shared fence; never replay its control.
    if (!resourceTarget || !reads.needsStatus(resourceTarget) || pendingMutation.current || verifyControl.current || !current() || !lifetime.current) return
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.current.signal, info.tab.signal])
    let checking = false
    const verify = async () => { if (checking || signal.aborted) return; checking = true; const version = reads.revision(); try { const status = await props.api.status(props.sessionId, signal); if (signal.aborted || !current() || !reads.accept(version, status.views)) return; const fresh = status.views.find(view => viewIdentity(view) === viewIdentity(resourceTarget)); setVerified({ key: viewIdentity(resourceTarget), floor: Math.max(resourceTarget.epoch, fresh?.epoch ?? 0), target: fresh }); setLive(undefined); verifyControl.current = undefined } catch { if (!signal.aborted && current()) setError(previous => previous || '当前状态未能确认，请刷新状态后再继续。') } finally { checking = false } }
    verifyControl.current = verify; void verify()
    return () => { controller.abort(); if (verifyControl.current === verify) verifyControl.current = undefined }
  }, [reads, readRevision, current, resourceTarget?.chatSessionId, resourceTarget?.environmentId, resourceTarget?.workbenchTabId, resourceTarget?.targetId, resourceTarget?.appId, props.api, props.sessionId, info.tab.signal])
  const onFrame = useCallback((frame: WorkbenchFrame) => { if (!reads.readable(frame.target)) return; setLive(frame.target); if (target && (target.title !== frame.target.title || target.state !== frame.target.state || target.epoch !== frame.target.epoch)) props.refresh(address) }, [reads, target?.title, target?.state, target?.epoch, props.refresh, address])
  const previewActive = useCallback(() => current() && !!target && reads.readable(target), [current, reads, target?.chatSessionId, target?.environmentId, target?.workbenchTabId, target?.targetId, target?.appId, target?.epoch])
  const readSignal = target ? reads.signal(target) : undefined, previewSignal = useMemo(() => readSignal ? AbortSignal.any([info.tab.signal, readSignal]) : info.tab.signal, [info.tab.signal, readSignal])
  const onActions = useCallback((actions: { act(action: ComputerAction): Promise<void>; refresh(): void }) => { surface.current = actions }, [])
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const read = async () => { if (!target || target.kind !== 'browser' || !current() || controller.signal.aborted) return; try { const value = await props.api.navigation(target, AbortSignal.any([controller.signal, info.tab.signal])); if (!controller.signal.aborted && current()) { setNavigation(value); if (!editingAddress.current) setAddressDraft(value.url ?? target.origin ?? '') } } catch { if (!controller.signal.aborted) setNavigation(undefined) } if (!controller.signal.aborted && current()) timer = setTimeout(read, 1200) }
    void read(); return () => { controller.abort(); clearTimeout(timer) }
  }, [props.api, target?.workbenchTabId, info.tab.signal, current])

  if (!enabled) return <p className="qyt-workbench-note">电脑操控已关闭。</p>
  if (!parsed || parsed.chatSessionId !== props.sessionId) return <p className="qyt-workbench-note">当前聊天无法打开这个视图。</p>
  return <div className="qyt-workbench-pane qyt-computer-surface"><div className="qyt-workbench-toolbar"><div className="qyt-workbench-heading"><strong>{selected?.title || '电脑工作台'}</strong><small>{selected?.origin || '授权桌面窗口'}</small></div><div className="qyt-workbench-actions">{selected && <WorkbenchControls target={selected} busy={busy || editingAnnotation || !readReady || !!selected && !reads.readable(selected)} control={operation => { void mutate(signal => props.api.control(selected, operation, signal), { target: selected, operation }) }}/>}<button type="button" className="qyt-button" disabled={busy || editingAnnotation} onClick={() => setNewPage(v => !v)}>新网页</button><button type="button" className="qyt-button" disabled={busy || editingAnnotation || !selected} onClick={() => { void openAnnotation() }}>批注画面</button><details className="qyt-workbench-layout"><summary className="qyt-button" aria-label="更多工作台操作">更多</summary><div className="qyt-workbench-more-menu" role="group" aria-label="更多工作台操作"><span className="qyt-workbench-menu-label">视图布局</span><button type="button" className="qyt-button" onClick={() => props.float(info.tab.id)}>弹出面板</button><button type="button" className="qyt-button" onClick={() => props.dock(info.panel.id)}>收回侧栏</button><button type="button" className="qyt-button" onClick={() => props.split(info.panel.id)}>分栏查看</button><span className="qyt-workbench-menu-separator"/><button type="button" className="qyt-button" onClick={() => info.tab.actions.close()}>隐藏视图</button>{selected?.kind === 'browser' && <button type="button" className="qyt-button" disabled={busy || editingAnnotation} onClick={() => { void mutate(async signal => { await props.api.closeEnvironment(props.sessionId, selected.environmentId, signal); if (!signal.aborted && current()) info.tab.actions.close() }) }}>退出专用浏览器</button>}{selected?.kind === 'browser' && <button type="button" className="qyt-button" disabled={busy || editingAnnotation || selected.state !== 'humanControl'} onClick={() => { void surface.current?.act({ kind: 'closeTab' }) }}>关闭网页</button>}</div></details></div>{selected?.kind === 'browser' && <form className="qyt-workbench-address" onSubmit={event => { event.preventDefault(); if (editingAnnotation) return; if (selected.state !== 'humanControl') { setError('请先接管，再通过地址栏导航；新网站可点击“新网页”授权打开。'); return } try { const next = website(addressDraft); void surface.current?.act({ kind: 'navigate', url: next.url }) } catch { setError('请输入完整的 HTTP 或 HTTPS 地址。') } }}><button type="button" className="qyt-button" aria-label="后退" disabled={busy || editingAnnotation || selected.state !== 'humanControl' || !navigation?.canGoBack} onClick={() => { void surface.current?.act({ kind: 'goBack' }) }}>←</button><button type="button" className="qyt-button" aria-label="前进" disabled={busy || editingAnnotation || selected.state !== 'humanControl' || !navigation?.canGoForward} onClick={() => { void surface.current?.act({ kind: 'goForward' }) }}>→</button><button type="button" className="qyt-button" aria-label="刷新网页" disabled={busy || editingAnnotation || selected.state !== 'humanControl'} onClick={() => { void surface.current?.act({ kind: 'reload' }) }}>↻</button><input disabled={editingAnnotation} aria-label="当前网页地址" value={addressDraft} placeholder={selected.origin} onFocus={() => { editingAddress.current = true }} onBlur={() => { editingAddress.current = false }} onChange={event => setAddressDraft(event.target.value)}/><button type="submit" className="qyt-button" disabled={busy || editingAnnotation || selected.state !== 'humanControl'}>前往</button></form>}</div>
    {annotation ? <AnnotationSessionView session={annotation} onClose={closeAnnotation}/> : openingAnnotation ? <p className="qyt-workbench-note" role="status">正在获取可核验的批注画面…</p> : newPage ? <NewWebsiteForm busy={busy} onCancel={() => setNewPage(false)} onOpen={async(url, browser, decision) => { await mutate(async signal => { const opened = await props.api.open(props.sessionId, url, browser, decision, signal); if (!signal.aborted && current()) { setNewPage(false); info.tab.actions.openResource(workbenchAddress(props.sessionId, opened.workbenchTabId)) } }) }}/>
      : target ? <WorkbenchSurface api={props.api} target={target} visible={info.tab.visible && reads.readable(target)} signal={previewSignal} active={previewActive} onFrame={onFrame} onActions={onActions}/>
      : <p className="qyt-workbench-note" role="status">{confirmed || resourceTarget && reads.retired(resourceTarget) || resource.status === 'failed' ? '此视图已结束或暂不可用。刷新后可在聊天小框中重新打开。' : '正在读取工作台…'}</p>}
    {(verifyControl.current || !readReady) && !busy && <button type="button" className="qyt-button" onClick={() => { if (!readReady) recheckRead(value => value + 1); else void verifyControl.current?.() }}>刷新状态</button>}
    {error && <p className="qyt-workbench-note" role="alert">{error}</p>}
    <div className="qyt-workbench-bottom"><span>{selected ? ({ ready: '已就绪', running: 'AI 正在操作', paused: '已暂停', humanControl: '你正在接管', background: '后台网页', awaitingPermission: '等待网站许可' } as Record<string, string>)[selected.state] || '等待当前状态' : '等待任务'}</span><span>隐藏视图会保留当前任务</span></div>
  </div>
}
interface NativeStatus { pendingRequests?: ComputerApprovalRequest[]; native?: ComputerNativeView | null }
export function WorkbenchInline({ sessionId, api, current, open, form, nativeCall }: { sessionId: string; api: WorkbenchAPI; current(chat: string): boolean; open(view: WorkbenchTarget): void; form: ConfigForm<Preferences>; nativeCall(op: string, chat: string, fields: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }) {
  const preferences = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot()), enabled = preferences.status === 'ready' && preferences.value?.enabled !== false && preferences.value?.computerUseEnabled === true
  const [status, setStatus] = useState<WorkbenchStatus>(), [native, setNative] = useState<NativeStatus>(), [selected, setSelected] = useState(''), [live, setLive] = useState<WorkbenchTarget>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [position, setPosition] = useState<{ x: number; y: number }>(), [limits, setLimits] = useState<{ maxWidth: number; maxHeight: number }>(), [dragging, setDragging] = useState(false), [checkEnvironment, setCheckEnvironment] = useState(false)
  const anchor = useRef<HTMLDivElement>(null), card = useRef<HTMLElement | null>(null), lifetime = useRef<AbortController>(), generation = useRef(0), pending = useRef(false), drag = useRef<{ id: number; x: number; y: number; left: number; top: number; handle: HTMLElement }>()
  const reads = useControlReads(sessionId, enabled, api)
  const active = useCallback(() => current(sessionId), [current, sessionId])
  useEffect(() => { setStatus(undefined); setNative(undefined); setSelected(''); setLive(undefined); setError(''); setCheckEnvironment(false) }, [sessionId, enabled])
  useEffect(() => {
    const controller = new AbortController(), revision = ++generation.current; lifetime.current = controller; pending.current = false; setBusy(false)
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => { if (controller.signal.aborted || !enabled || !active()) return; const readVersion = reads.revision(); try { const [value, original] = await Promise.all([api.status(sessionId, controller.signal), nativeCall('pending', sessionId, {}, controller.signal) as Promise<NativeStatus>]); if (!controller.signal.aborted && revision === generation.current && active() && reads.accept(readVersion, value.views)) { setStatus(value); setNative(original) } } catch { if (!controller.signal.aborted && revision === generation.current && active()) setError(previous => previous || '任务状态暂不可用，请稍后刷新。') } if (!controller.signal.aborted && active()) timer = setTimeout(poll, 1200) }
    void poll(); return () => { controller.abort(); clearTimeout(timer); generation.current++ }
  }, [enabled, sessionId, api, active, nativeCall, refresh, reads])
  const recoverable = status?.environments?.filter(value => value.kind === 'browser' && ['startupUnconfirmed', 'cleanupRequired'].includes(value.state)) ?? [], views = status?.views.filter(view => view.chatSessionId === sessionId).flatMap(view => { const current = reads.target(view); return current ? [current] : [] }) ?? [], target = views.find(view => view.workbenchTabId === selected) ?? views.at(-1), displayed = live && target && viewIdentity(live) === viewIdentity(target) && live.epoch >= target.epoch ? live : target, siteRequests = status?.pendingRequests.filter(request => request.chatSessionId === sessionId) ?? [], nativeRequests = (native?.pendingRequests ?? []).filter(request => request.sessionId === sessionId && request.state === 'pending')
  const mutate = async (work: (signal: AbortSignal) => Promise<unknown>, controlled?: { target: WorkbenchTarget; operation: string }) => {
    if (pending.current || !lifetime.current || !active() || controlled && !reads.readable(controlled.target)) return
    pending.current = true; const controller = lifetime.current, revision = generation.current, fence = controlled ? reads.block(controlled.target, controller.signal) : undefined
    setBusy(true); setError('')
    try {
      await work(controller.signal)
      if (!controller.signal.aborted && revision === generation.current && active()) {
        if (fence) reads.settle(fence, controlled?.operation === 'stop')
        if (controlled?.operation === 'stop') { const key = viewIdentity(controlled.target); setStatus(value => value ? { ...value, views: value.views.filter(view => viewIdentity(view) !== key) } : value); setLive(value => value && viewIdentity(value) === key ? undefined : value) }
        setRefresh(v => v + 1)
      }
    } catch {
      if (!controller.signal.aborted && revision === generation.current && active()) { if (fence) { reads.settle(fence); setRefresh(v => v + 1) }; setError('操作结果未能确认，请展开工作台刷新查看；不要重复提交。') }
    } finally { if (!controller.signal.aborted && revision === generation.current) { pending.current = false; setBusy(false) } }
  }
  const cancelDrag = () => { const value = drag.current; drag.current = undefined; if (value?.handle.hasPointerCapture?.(value.id)) value.handle.releasePointerCapture(value.id); setDragging(false) }
  const clamp = (point: { x: number; y: number }) => anchor.current ? inlinePreviewLayout(anchor.current, card.current, sessionId, point) : point
  useLayoutEffect(() => { cancelDrag(); setPosition(undefined); setLimits(undefined) }, [sessionId])
  useLayoutEffect(() => {
    if (!enabled || (!views.length && !siteRequests.length && !nativeRequests.length && !recoverable.length) || !anchor.current) return
    const view = anchor.current.ownerDocument.defaultView ?? window, bound = () => {
      if (!anchor.current) return
      const area = inlinePreviewBounds(anchor.current, sessionId), box = card.current?.getBoundingClientRect()
      setPosition(previous => { const next = inlinePreviewLayout(anchor.current!, card.current, sessionId, previous ?? { x: area.right - (box?.width || 300) - 16, y: area.top + 16 }); return previous?.x === next.x && previous.y === next.y ? previous : { x: next.x, y: next.y } })
      const next = inlinePreviewLayout(anchor.current, card.current, sessionId, { x: 0, y: 0 }); setLimits(previous => previous?.maxWidth === next.maxWidth && previous.maxHeight === next.maxHeight ? previous : { maxWidth: next.maxWidth, maxHeight: next.maxHeight })
    }
    bound(); const remove = observeInlinePreviewLayout(anchor.current, card.current, sessionId, bound); view.addEventListener('blur', cancelDrag)
    return () => { remove(); view.removeEventListener('blur', cancelDrag); cancelDrag() }
  }, [enabled, sessionId, views.length, siteRequests.length, nativeRequests.length, recoverable.length, checkEnvironment])
  const onFrame = useCallback((frame: WorkbenchFrame) => { if (reads.readable(frame.target)) setLive(frame.target) }, [reads])
  const previewActive = useCallback(() => active() && !!target && reads.readable(target), [active, reads, target?.chatSessionId, target?.environmentId, target?.workbenchTabId, target?.targetId, target?.appId, target?.epoch])
  if (!enabled || !active() || (!target && !siteRequests.length && !nativeRequests.length && !recoverable.length)) return null
  const style: React.CSSProperties = { ...limits, visibility: limits && (!limits.maxWidth || !limits.maxHeight) ? 'hidden' : undefined, ...(position ? { left: position.x, top: position.y } : { right: 16, top: 72 }) }
  const nativeDecision = (request: ComputerApprovalRequest, decision: ComputerDecision) => mutate(signal => nativeCall('decide', sessionId, { requestId: request.requestId, requestVersion: request.requestVersion, ...(request.taskId ? { taskId: request.taskId } : {}), decision }, signal))
  return <><div ref={anchor} className="qyt-workbench-small-anchor" data-qyt-workbench-anchor={sessionId}/>{createPortal(<div className="qyt-workbench-small-portal qyt-computer-surface" data-qyt-workbench-chat={sessionId}>
    {siteRequests.length || nativeRequests.length ? <div ref={node => { card.current = node }} className="qyt-workbench-approvals" style={style}>{nativeRequests.map(request => <React.Fragment key={request.requestId}><SystemPermissionNotice native={request.preflight ?? native?.native} busy={busy} onOpenSettings={kind => { void mutate(signal => nativeCall('openSettings', sessionId, { kind }, signal)) }} onRefresh={() => setRefresh(v => v + 1)}/><ComputerApprovalCard request={request} busy={busy} allowDisabled={computerApprovalNeedsSystemPermissions(request.preflight ?? native?.native)} onDecision={decision => { void nativeDecision(request, decision) }}/></React.Fragment>)}{siteRequests.map(request => <SiteApprovalCard key={request.requestId} request={request} busy={busy} decide={choice => { void mutate(signal => api.decide(request, choice, signal)) }}/>)}</div>
      : recoverable.length && (!target || checkEnvironment) ? <section ref={node => { card.current = node }} className="qyt-workbench-approvals" style={style} aria-label="浏览器环境需要检查"><strong>浏览器打开或退出尚未确认</strong><p className="qyt-computer-caption">先结束本插件的专用浏览器环境，再在聊天中提出任务。若尚未退出，请手动关闭该专用浏览器后再检查。</p>{recoverable.map(environment => <button key={environment.environmentId} type="button" className="qyt-button" disabled={busy} onClick={() => { void mutate(signal => api.closeEnvironment(sessionId, environment.environmentId, signal)) }}>结束 {environment.title}</button>)}{target && <button type="button" className="qyt-button" disabled={busy} onClick={() => setCheckEnvironment(false)}>返回预览</button>}</section>
      : target && displayed && <div ref={node => { card.current = node }} className="qyt-workbench-small" style={style} aria-label="电脑实时预览" data-dragging={dragging} onPointerMove={event => { const d = drag.current; if (!d || d.id !== event.pointerId) return; event.preventDefault(); setPosition(clamp({ x: d.left + event.clientX - d.x, y: d.top + event.clientY - d.y })) }} onPointerUp={cancelDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
        <WorkbenchSurface api={api} target={target} compact visible={reads.readable(target)} signal={reads.signal(target)} active={previewActive} onFrame={onFrame}/>
        {views.length > 1 && <div className="qyt-computer-inline-tasks" role="tablist" aria-label="当前聊天的电脑任务" onPointerDown={event => event.stopPropagation()}>{views.map((view, index) => <button key={view.workbenchTabId} type="button" role="tab" aria-selected={view.workbenchTabId === target.workbenchTabId} aria-label={`切换电脑任务 ${index + 1}：${view.title || '未命名'}`} title={view.title || '未命名'} disabled={busy && !reads.pending()} onClick={() => { cancelDrag(); setSelected(view.workbenchTabId); setLive(undefined) }}><span/>{index + 1}</button>)}</div>}
        <div className="qyt-workbench-small-overlay"><button type="button" className="qyt-workbench-small-grip" aria-label="拖动电脑小预览" title="拖动小预览；方向键移动" onPointerDown={event => { if (event.button !== 0 || event.isPrimary === false || !card.current) return; event.preventDefault(); const box = card.current.getBoundingClientRect(); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: position?.x ?? box.left, top: position?.y ?? box.top, handle: event.currentTarget }; event.currentTarget.setPointerCapture?.(event.pointerId); setDragging(true) }} onKeyDown={event => { const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key]; if (!delta || !card.current) return; event.preventDefault(); const box = card.current.getBoundingClientRect(), step = event.shiftKey ? 40 : 8; setPosition(clamp({ x: (position?.x ?? box.left) + delta[0] * step, y: (position?.y ?? box.top) + delta[1] * step })) }}><svg viewBox="0 0 12 18" fill="currentColor" aria-hidden="true"><circle cx="3" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="3" cy="9" r="1"/><circle cx="8" cy="9" r="1"/><circle cx="3" cy="14" r="1"/><circle cx="8" cy="14" r="1"/></svg></button>{recoverable.length > 0 && <button type="button" className="qyt-button" onClick={() => setCheckEnvironment(true)}>检查浏览器</button>}<WorkbenchControls target={displayed} choices={views} choose={id => { setSelected(id); setLive(undefined) }} busy={busy || !reads.readable(displayed)} control={operation => { void mutate(signal => api.control(displayed, operation, signal), { target: displayed, operation }) }} open={() => open(displayed)}/></div>
      </div>}
    {error && <span className="sr-only" role="alert">{error}</span>}
  </div>, anchor.current?.ownerDocument.body ?? document.body)}</>
}
/** Real public SDK tabs own floats/splits/fullscreen/close/reopen; the plugin does not emulate their window manager. */
export function installWorkbenchClient(ctx: Context, form: ConfigForm<Preferences>): () => void {
  let disposed = false
  const annotations = createAnnotationAPI(() => ctx.get('connection') as WorkbenchConnection | undefined)
  const binding = (chat: string) => { if (!current(chat)) return undefined; const sessions = ctx.get('sessions') as ISessions | undefined; return sessions?.binding(chat as SessionId) }
  const bus = new WorkbenchRefreshBus(), api = createWorkbenchAPI(() => ctx.get('connection') as WorkbenchConnection | undefined), current = (chat: string) => !disposed && ctx.sidebarRight.mounted.getSnapshot() === chat
  const open = (target: WorkbenchTarget) => { if (!current(target.chatSessionId)) return; const address = workbenchAddress(target.chatSessionId, target.workbenchTabId); ctx.sidebarRight.openResource(address); const tab = ctx.sidebarRight.active(); if (current(target.chatSessionId) && tab?.kind === 'qiuya-workbench' && tab.contentId === address) ctx.sidebarRight.float(tab.id, workbenchFloatRect({ width: window.innerWidth, height: window.innerHeight })) }
  const refresh = (address: string) => { const target = parseWorkbenchAddress(address); if (target && current(target.chatSessionId)) bus.refresh(address) }
  const nativeCall = async (op: string, chat: string, fields: Record<string, unknown>, signal: AbortSignal) => { signal.throwIfAborted(); const peer = ctx.get('connection') as WorkbenchConnection | undefined; if (!peer || !current(chat)) throw Error('聊天已变化'); const result = await peer.rpc.call('/api', 'qiuya-tools.computer.control', { op, sessionId: chat, ...fields }, signal); signal.throwIfAborted(); if (!Object.is(ctx.get('connection'), peer) || !current(chat) || !result.ok) throw Error('电脑状态暂不可用'); return result.value }
  const remove: Array<() => void> = []
  let style: HTMLStyleElement | undefined
  const cleanup = () => { if (disposed) return; disposed = true; const failures: unknown[] = []; for (const work of [() => bus.dispose(), () => style?.remove(), ...remove.splice(0).reverse()]) try { work() } catch (failure) { failures.push(failure) } if (failures.length) throw new AggregateError(failures, '工作台视图卸载尚未确认。') }
  const register = (dispose: () => void) => { remove.push(dispose) }
  try { [register(ctx.resources.register(createWorkbenchResourceProvider(api, bus, current))), register(ctx.sidebarRightTabs.register({ id: TAB_ID, kind: 'qiuya-workbench', patterns: ['dsh-resource://qiuya-workbench/**'], canOpen: address => parseWorkbenchAddress(address) !== null, title: () => '电脑工作台', multiple: true, keepMounted: false })), register(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: sessionId => ({ form, api, annotations, binding, current, open, refresh, float(id) { if (current(sessionId)) ctx.sidebarRight.float(id, workbenchFloatRect({ width: window.innerWidth, height: window.innerHeight })) }, dock(id) { if (current(sessionId)) ctx.sidebarRight.dock(id) }, split(id) { if (current(sessionId)) ctx.sidebarRight.split(id) } }) }, WorkbenchTab))), register(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, WorkbenchTitle))), register(ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({ name: 'conversation.input.overlay', id: 'qiuya-tools-workbench-inline', order: 85 }, function Inline({ sessionId }: PropsRuntime<'conversation.input.overlay'>) {
    const mountedChat = useSyncExternalStore(listener => ctx.sidebarRight.mounted.subscribe(listener), () => ctx.sidebarRight.mounted.getSnapshot(), () => undefined)
    const mountedCurrent = useCallback((chat: string) => mountedChat === chat && current(chat), [mountedChat])
    return <WorkbenchInline sessionId={sessionId} api={api} current={mountedCurrent} open={open} form={form} nativeCall={nativeCall}/>
  })))]
    style = document.createElement('style'); style.dataset.plugin = 'qiuya-tools-workbench'; style.textContent = workbenchStyles; document.head.append(style)
  } catch (failure) { const failures = [failure]; try { cleanup() } catch (error) { failures.push(error) } throw new AggregateError(failures, '工作台视图注册未完成。') }
  return cleanup
}
