import React, { useEffect, useId, useRef, useState } from 'react'
import { ComputerIcon, type ComputerNativeView } from './presentation.tsx'
import type { ExchangeFile, ExchangeRequest, ExchangeResult } from './exchange.ts'

export type ComputerEnvironmentCall = (op: string, extra?: object, signal?: AbortSignal) => Promise<unknown>
export interface ComputerEnvironmentStatus {
  tasks?: { chatSessionId: string; taskId: string; taskLabel?: string }[]
  native?: ComputerNativeView | null
  environments?: { environmentId?: string; sessionId?: string; mode: 'local' | 'remote' | 'browser'; switching?: boolean; retiring?: boolean }[]
}

export function FileExchangePanel({ call }: { call: ComputerEnvironmentCall }) {
  const [listing, setListing] = useState<ExchangeResult>(), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  // Each mount owns one captured environment call. A late upload must never
  // continue through a replacement chat's newly rendered call prop.
  const mounted = useRef(true), ownerCall = useRef(call), pending = useRef(false), controller = useRef<AbortController>()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort() } }, [])
  const request = async (value: ExchangeRequest, cleanup = false) => await ownerCall.current('exchange', { request: value }, cleanup ? undefined : controller.current?.signal) as ExchangeResult
  const assertMounted = () => { if (!mounted.current) throw new Error('文件交换面板已关闭。') }
  const refresh = async () => {
    const status = await request({ action: 'status' })
    assertMounted()
    const result = status.enabled ? await request({ action: 'list' }) : status
    assertMounted()
    if (mounted.current) setListing(result)
    return result
  }
  const upload = async (file: File) => {
    if (pending.current) return
    pending.current = true; controller.current = new AbortController()
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
        assertMounted()
        if (result.offset !== offset + chunk.length) throw new Error('远端上传位置不一致，上传已取消。')
        offset += chunk.length
      }
      if (!mounted.current) throw new Error('文件交换面板已关闭。')
      const published = await request({ action: 'commit', id })
      if (published.done !== true || published.file?.name !== file.name || published.file.size !== file.size) throw new Error('远端未确认完整文件，请刷新列表检查，不要自动重传。')
      committed = true; assertMounted(); await refresh()
      if (mounted.current) setMessage('文件已上传至远端专用交换目录。')
    } catch (error) { if (mounted.current) setMessage((error as Error).message) }
    finally {
      if (id && !committed) await request({ action: 'abort', id }, true).catch(() => {})
      pending.current = false; if (mounted.current) setBusy(false)
    }
  }
  const download = async (file: ExchangeFile) => {
    if (pending.current) return
    pending.current = true; controller.current = new AbortController()
    setBusy(true); setMessage('正在下载…')
    try {
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 8 * 1024 * 1024) throw new Error('远端文件超过 8 MiB 限制。')
      const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0
      do {
        if (!mounted.current) throw new Error('文件交换面板已关闭。')
        const result = await request({ action: 'read', name: file.name, version: file.version, offset })
        assertMounted()
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
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="qyt-card qyt-computer-file-exchange"><h4>手动文件交换</h4><p className="qyt-muted">仅操作远端代理管理者明确启用的专用目录。单文件最多 8 MiB，不覆盖同名文件；不分享本机文件路径，也不给聊天模型文件操作能力。</p>
    <button type="button" className="qyt-button" disabled={busy} onClick={() => { if (pending.current) return; pending.current = true; controller.current = new AbortController(); setBusy(true); setMessage(''); void refresh().catch(error => { if (mounted.current) setMessage(error.message) }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) }) }}>检查并刷新交换目录</button>
    {listing && !listing.enabled && <p>远端尚未开启文件交换。请由代理管理者设置 QIUYA_COMPUTER_EXCHANGE_DIR 为专用真实目录后重启代理。</p>}
    {listing?.enabled && <><label>选择本机文件并上传 <input type="file" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file) }}/></label>
      {listing.files?.map(file => <p key={file.name}>{file.name} · {file.size} 字节 <button type="button" className="qyt-button" disabled={busy} onClick={() => { void download(file) }}>下载</button></p>)}
      {!listing.files?.length && <p>专用目录暂无可交换的普通文件。</p>}{listing.truncated && <p>列表最多显示 100 个文件；请由目录管理者整理后刷新。</p>}
    </>}{message && <p role="status">{message}</p>}
  </div>
}

type EnvironmentMode = 'local' | 'remote' | 'browser'
const environmentNames: Record<EnvironmentMode, string> = { local: '这台电脑', browser: '独立浏览器', remote: '远端电脑' }
const environmentDescriptions: Record<EnvironmentMode, string> = { local: '操作本机应用与浏览器', browser: '使用独立配置访问指定网站', remote: '连接虚拟机或另一台电脑' }
function EnvironmentIcon({ mode }: { mode: EnvironmentMode }) {
  if (mode === 'local') return <ComputerIcon/>
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{mode === 'browser' ? <><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01M9 14l-2 2 2 2m6-4 2 2-2 2"/></> : <><rect x="2.5" y="3.5" width="13" height="10" rx="2"/><path d="M6 17h6m-3-3.5V17m8-9h2.5a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2v-1m5-1h2"/></>}</svg>
}

/** The caller is a public composer slot and binds every request to its own
 * sessionId. No global current-seat lookup or unscoped fallback is used here. */
export function ComputerEnvironmentPanel({ sessionId, enabled, disabled = false, status, call, onChanged, onClose }: {
  sessionId: string; enabled: boolean; disabled?: boolean; status: ComputerEnvironmentStatus; call: ComputerEnvironmentCall
  onChanged(): Promise<void>; onClose?(): void
}) {
  const connected = status.environments?.find(row => row.sessionId === sessionId)
  const [mode, setMode] = useState<EnvironmentMode>(connected?.mode ?? 'local')
  const [endpoint, setEndpoint] = useState(''), [token, setToken] = useState(''), [allowPrivate, setAllowPrivate] = useState(false)
  const [browser, setBrowser] = useState<'chrome' | 'edge'>('chrome'), [origins, setOrigins] = useState(''), [initialUrl, setInitialUrl] = useState(''), [cdpEndpoint, setCdpEndpoint] = useState('')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [fileGeneration, setFileGeneration] = useState(0)
  const groupId = useId(), dirty = useRef(false), mounted = useRef(true), generation = useRef(0), performing = useRef(false), request = useRef<AbortController>()
  const previousSession = useRef(sessionId), environmentGeneration = useRef(0)
  const latest = useRef({ sessionId, enabled, disabled, connected })
  latest.current = { sessionId, enabled, disabled, connected }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; environmentGeneration.current++; request.current?.abort() } }, [])
  useEffect(() => {
    generation.current++; environmentGeneration.current++; request.current?.abort(); performing.current = false
    setBusy(false); setMessage(''); setToken(''); setEndpoint(''); setAllowPrivate(false)
    setOrigins(''); setInitialUrl(''); setCdpEndpoint(''); setFileGeneration(value => value + 1)
    if (previousSession.current !== sessionId) {
      previousSession.current = sessionId; dirty.current = false; setMode(connected?.mode ?? 'local'); setBrowser('chrome')
    }
  }, [sessionId, enabled, disabled])
  useEffect(() => {
    // A late status read may update the actual environment, but cannot replace
    // a browser or remote draft the owner has already started preparing.
    if (!dirty.current && !performing.current) setMode(connected?.mode ?? 'local')
  }, [sessionId, connected?.mode])
  const markDraft = (change: () => void) => { dirty.current = true; change(); setMessage('') }
  const current = (id: number) => mounted.current && generation.current === id && latest.current.sessionId === sessionId && latest.current.enabled && !latest.current.disabled
  const unavailable = !enabled || disabled || busy || connected?.switching === true || connected?.retiring === true
  const connect = async () => {
    if (performing.current || unavailable || !sessionId || mode === 'remote' && (!endpoint.trim() || !token.trim()) || mode === 'browser' && !origins.trim()) return
    performing.current = true; const id = ++generation.current, operation = new AbortController(); request.current = operation
    // Retire the old exchange mount before any request changes the backend.
    environmentGeneration.current++; setFileGeneration(value => value + 1); setBusy(true); setMessage('')
    try {
      const value = await call('connect', {
        mode, ...(mode === 'remote' ? { endpoint: endpoint.trim(), token, allowPrivateNetwork: allowPrivate } : {}),
        ...(mode === 'browser' ? { browser, allowedOrigins: origins.split(/[\n,]+/u).map(value => value.trim()).filter(Boolean), ...(initialUrl.trim() ? { initialUrl: initialUrl.trim() } : {}), ...(cdpEndpoint.trim() ? { cdpEndpoint: cdpEndpoint.trim() } : {}) } : {}),
      }, operation.signal) as ComputerNativeView | null | undefined
      if (!current(id)) return
      if (value?.available !== true) { setMessage(value?.message || '所选环境尚未就绪，请检查连接或系统权限后重试。'); return }
      setToken('')
      await onChanged()
      if (current(id)) onClose?.()
    } catch (error) { if (current(id)) setMessage(error instanceof Error ? error.message : '环境连接失败，请重试。') }
    finally { if (current(id)) { performing.current = false; setBusy(false) } }
  }
  const exchangeGeneration = environmentGeneration.current
  const exchangeId = typeof connected?.environmentId === 'string' && connected.environmentId.trim() ? connected.environmentId : undefined
  const exchangeCall: ComputerEnvironmentCall = (op, extra, signal) => {
    const seat = latest.current
    if (!exchangeId || seat.connected?.environmentId !== exchangeId || environmentGeneration.current !== exchangeGeneration || seat.sessionId !== sessionId || !seat.enabled || seat.disabled || seat.connected?.mode !== 'remote' || seat.connected.switching || seat.connected.retiring) return Promise.reject(new Error('文件交换环境已变化，请重新打开。'))
    return call(op, { ...extra, expectedEnvironmentId: exchangeId }, signal)
  }
  const remoteReady = !!exchangeId && enabled && !disabled && !busy && mode === 'remote' && connected?.mode === 'remote' && !connected.switching && !connected.retiring && status.native?.available !== false
  return <div className="qyt-computer-environment-panel" data-qyt-environment-session={sessionId}>
    <p className="qyt-computer-caption">切换环境会停止当前聊天的电脑任务。</p>
    <p className="qyt-computer-environment-current qyt-computer-caption">当前环境：{environmentNames[connected?.mode ?? 'local']}{connected?.switching ? ' · 正在切换' : connected?.retiring ? ' · 正在清理' : ''}</p>
    <form onSubmit={event => { event.preventDefault(); void connect() }}>
      <fieldset className="qyt-computer-environment-fields" disabled={unavailable}>
        <legend className="qyt-computer-caption">为当前会话选择环境</legend>
        <div className="qyt-computer-environment-options">
          {(['local', 'browser', 'remote'] as const).map(value => <label className="qyt-computer-environment-option" data-selected={mode === value} key={value}>
            <input type="radio" name={groupId} value={value} checked={mode === value} onChange={() => markDraft(() => setMode(value))}/>
            <span className="qyt-computer-environment-option-icon"><EnvironmentIcon mode={value}/></span><span><strong>{environmentNames[value]}</strong><span className="qyt-computer-caption">{environmentDescriptions[value]}</span></span>
          </label>)}
        </div>
        <div className="qyt-computer-fields">
          {mode === 'remote' && <><label>配对地址<input type="url" value={endpoint} placeholder="https://computer.example/v1/computer" onChange={event => markDraft(() => setEndpoint(event.target.value))}/></label><label>配对密钥<input type="password" autoComplete="off" value={token} onChange={event => markDraft(() => setToken(event.target.value))}/></label><label className="qyt-computer-check"><input type="checkbox" checked={allowPrivate} onChange={event => markDraft(() => setAllowPrivate(event.target.checked))}/>允许连接受信任的私有网络</label></>}
          {mode === 'browser' && <><label>浏览器<select value={browser} onChange={event => markDraft(() => setBrowser(event.target.value as typeof browser))}><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select></label><label>允许的网站来源（每行一个）<textarea rows={3} value={origins} placeholder="https://example.com" onChange={event => markDraft(() => setOrigins(event.target.value))}/></label><label>起始页面<input type="url" value={initialUrl} placeholder="https://example.com/" onChange={event => markDraft(() => setInitialUrl(event.target.value))}/></label><details><summary>连接现有浏览器</summary><label>本机调试地址（可选）<input type="url" value={cdpEndpoint} placeholder="http://127.0.0.1:9222" onChange={event => markDraft(() => setCdpEndpoint(event.target.value))}/></label></details><p className="qyt-muted">默认打开独立浏览器配置，只访问你列出的网站。</p></>}
        </div>
        <div className="qyt-computer-actions"><button type="submit" className="qyt-button qyt-button-primary" disabled={unavailable || !sessionId || mode === 'remote' && (!endpoint.trim() || !token.trim()) || mode === 'browser' && !origins.trim()}>{busy ? '正在连接…' : '使用此环境'}</button>{onClose && <button type="button" className="qyt-button" onClick={onClose}>取消</button>}</div>
      </fieldset>
    </form>
    {!enabled && <p className="qyt-computer-caption">请先在工具箱设置中启用电脑操控。</p>}
    {remoteReady && <FileExchangePanel key={`${sessionId}:${exchangeId}:${fileGeneration}`} call={exchangeCall}/>}
    {message && <p className="qyt-computer-error" role="alert">{message}</p>}
  </div>
}
