import React, { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ComputerSessionSnapshot, NativeTarget } from './contract.ts'
import type { ExchangeFile, ExchangeRequest, ExchangeResult } from './exchange.ts'

interface Rpc { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } }
interface Catalog { list: { getSnapshot(): { ids: string[]; byId: Record<string, { displayTitle?: string; title?: string; blank?: boolean; origin?: string }> } } }
const endpoint = 'qiuya-tools.computer.control'
type NativeView = { permissions?: Record<string, boolean>; message?: string; mode?: 'local' | 'remote' | 'browser' }
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
  const [targets, setTargets] = useState<NativeTarget[]>([]), [targetId, setTargetId] = useState('')
  const [sessionId, setSessionId] = useState(() => typeof document === 'undefined' ? '' : document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? '')
  const [sessions, setSessions] = useState<ComputerSessionSnapshot[]>([]), [allowed, setAllowed] = useState<string[]>([])
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [native, setNative] = useState<NativeView | null>(), [fileGeneration, setFileGeneration] = useState(0)
  const [chats, setChats] = useState<{ id: string; title: string }[]>([])
  const [mode, setMode] = useState<'local' | 'remote' | 'browser'>('local'), [endpointUrl, setEndpointUrl] = useState(''), [token, setToken] = useState(''), [allowPrivate, setAllowPrivate] = useState(false)
  const [browser, setBrowser] = useState<'chrome' | 'edge'>('chrome'), [origins, setOrigins] = useState(''), [initialUrl, setInitialUrl] = useState(''), [cdpEndpoint, setCdpEndpoint] = useState('')
  const revision = useRef(0), mounted = useRef(true), performing = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++ } }, [])
  const call = async (op: string, extra: object = {}) => {
    const connection = ctx.get('connection') as Rpc | undefined
    if (!connection) throw new Error('连接尚未就绪')
    const response = await connection.rpc.call('/api', endpoint, { op, ...(sessionId ? { sessionId } : {}), ...extra })
    if (!response.ok) throw new Error(response.error?.message ?? '电脑操控请求失败')
    return response.value
  }
  const refresh = async () => {
    const generation = revision.current
    const result = await call('status') as { sessions: ComputerSessionSnapshot[]; allowedApps: string[]; native: NativeView | null }
    if (!mounted.current || generation !== revision.current) return
    setSessions(result.sessions); setAllowed(result.allowedApps); setNative(result.native)
    const catalog = (ctx.get('sessions') as Catalog | undefined)?.list.getSnapshot()
    if (catalog) setChats(catalog.ids.filter(id => catalog.byId[id]?.origin !== 'subagent').map(id => ({ id, title: catalog.byId[id].displayTitle ?? catalog.byId[id].title ?? id })))
  }
  useEffect(() => {
    revision.current++; setTargets([]); setTargetId(''); setNative(undefined); setMessage(''); setToken(''); setEndpointUrl(''); setMode('local'); setBusy(false)
    setFileGeneration(value => value + 1)
    if (!enabled) return
    let disposed = false
    const run = async () => { try { if (!disposed) await refresh() } catch (error) { if (!disposed) setMessage((error as Error).message) } }
    void run(); const timer = window.setInterval(() => { void run() }, 1500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [enabled, sessionId])
  const action = async (op: string, extra = {}) => {
    if (performing.current) return
    if (!sessionId) { setMessage('请先选择关联聊天。'); return }
    performing.current = true
    const generation = revision.current
    setBusy(true); setMessage('')
    try {
      const result = await call(op, extra)
      if (!mounted.current || generation !== revision.current) return
      if (op === 'connect') { setTargets([]); setTargetId(''); setFileGeneration(value => value + 1) }
      if (op === 'targets') { const list = result as NativeTarget[]; setTargets(list); if (!list.some(t => t.id === targetId)) setTargetId(list[0]?.id ?? '') }
      await refresh()
    } catch (error) { if (mounted.current && generation === revision.current) setMessage((error as Error).message) }
    finally { performing.current = false; if (mounted.current && generation === revision.current) setBusy(false) }
  }
  const current = sessions.find(item => item.sessionId === sessionId)
  return <div className="qyt-feature-panel">
    <div className="qyt-card"><div className="qyt-toggle-row"><h3>电脑操控</h3><label><input type="checkbox" checked={enabled} disabled={disabled} onChange={e => onEnabled(e.target.checked)}/> 启用</label></div>
      <p className="qyt-muted">每个聊天都有独立的小预览、AI 指针和暂停状态，预览可随时弹出为大窗口或收回。当前聊天需选择支持图片输入的模型。</p>
      {enabled && <><p>独立浏览器和远端环境可同时工作；操作同一台电脑时，鼠标和键盘按任务顺序执行。</p>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>关联聊天 <select value={sessionId} disabled={busy} onChange={e => setSessionId(e.target.value)} style={{ maxWidth: '100%' }}><option value="">请选择聊天</option>{chats.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label>操作环境 <select value={mode} onChange={e => setMode(e.target.value as 'local' | 'remote' | 'browser')}><option value="local">这台电脑</option><option value="remote">独立虚拟机或远端电脑</option><option value="browser">浏览器专用通道</option></select></label>
          {mode === 'remote' && <><label>配对地址 <input type="url" value={endpointUrl} placeholder="https://computer.example/v1/computer" onChange={e => setEndpointUrl(e.target.value)}/></label><label>配对密钥 <input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}/></label><label><input type="checkbox" checked={allowPrivate} onChange={e => setAllowPrivate(e.target.checked)}/> 允许通过受信任的私有网络连接（例如本机虚拟机）</label></>}
          {mode === 'browser' && <><label>浏览器 <select value={browser} onChange={e => setBrowser(e.target.value as 'chrome' | 'edge')}><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select></label><label>允许的网站来源（每行一个）<textarea rows={3} value={origins} placeholder="https://example.com" onChange={e => setOrigins(e.target.value)}/></label><label>起始页面 <input type="url" value={initialUrl} placeholder="https://example.com/" onChange={e => setInitialUrl(e.target.value)}/></label><details><summary>连接已开启调试的浏览器</summary><label>本机调试地址（可选）<input type="url" value={cdpEndpoint} placeholder="http://127.0.0.1:9222" onChange={e => setCdpEndpoint(e.target.value)}/></label></details><p className="qyt-muted">默认打开独立的浏览器配置，可在其中登录。只允许列出的网站；修改后重新连接即生效。浏览器通道可在后台操作标签页。</p></>}
          <button className="qyt-button" disabled={busy || !sessionId || mode === 'remote' && (!endpointUrl || !token) || mode === 'browser' && !origins.trim()} onClick={() => { void action('connect', { mode, endpoint: endpointUrl, token, allowPrivateNetwork: allowPrivate, browser, allowedOrigins: origins.split(/[\n,]+/u).map(value => value.trim()).filter(Boolean), initialUrl: initialUrl || undefined, cdpEndpoint: cdpEndpoint || undefined }) }}>为此聊天连接环境</button>
          {sessionId && native?.mode && <p className="qyt-muted">此聊天已连接：{({ local: '这台电脑', remote: '远端电脑', browser: '独立浏览器' })[native.mode]}</p>}
          {mode === 'remote' && native?.mode === 'remote' && !busy && <FileExchangePanel key={`${sessionId}:${fileGeneration}`} call={call}/>}
          <label>应用窗口 <select value={targetId} onChange={e => setTargetId(e.target.value)} style={{ maxWidth: '100%' }}><option value="">请刷新窗口列表</option>{targets.map(item => <option key={item.id} value={item.id}>{item.title || item.appId}</option>)}</select></label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="qyt-button" disabled={busy || !sessionId} onClick={() => { void action('targets') }}>刷新窗口</button>
            <button className="qyt-button" disabled={busy || !sessionId || !targetId} onClick={() => { void action('start', { targetId }) }}>允许本次并开始</button>
            <button className="qyt-button" disabled={busy || !current || current.state === 'stopped'} onClick={() => { void action('preview') }}>弹出大预览</button>
            <button className="qyt-button" disabled={busy || !current || current.state === 'stopped'} onClick={() => { void action('redock') }}>收回到聊天</button>
            {(['pause', 'takeover', 'resume', 'stop'] as const).map((op, i) => <button className="qyt-button" key={op} disabled={busy || !current} onClick={() => { void action(op) }}>{['暂停', '接管', '继续', '停止'][i]}</button>)}
          </div>
          {current && <p role="status">{current.target?.title} · {current.state}{current.error ? ` · ${current.error.message}` : ''}</p>}
        </div>
        <div><strong>系统权限</strong>{native?.permissions && Object.entries(native.permissions).map(([key, granted]) => <p key={key}>{({ screenRecording: '屏幕录制', accessibility: '辅助功能', inputMonitoring: '输入监控' } as Record<string, string>)[key] ?? key}：{granted ? '已允许' : '未允许'}</p>)}{native?.message && <p>{native.message}</p>}</div>
        <p className="qyt-muted">Mac 需要在系统设置中允许“QiuYaTools Computer”的屏幕录制和辅助功能。Windows 桌面操作会使用当前前台输入。收回预览和切换聊天会继续后台任务；直接关闭大预览会暂停对应任务。</p>
      </>}
      {message && <p role="alert">{message}</p>}
    </div>
    {enabled && <div className="qyt-card"><h4>始终允许的应用</h4><p className="qyt-muted">持续授权由你管理，撤销后立即停止该应用的操作。</p>
      {targetId && targets.find(t => t.id === targetId) && <button className="qyt-button" disabled={busy} onClick={() => { void action('allow', { appId: targets.find(t => t.id === targetId)!.appId, allowed: true }) }}>始终允许所选应用</button>}
      {allowed.map(appId => <p key={appId}>{appId} <button disabled={busy} onClick={() => { void action('allow', { appId, allowed: false }) }}>撤销</button></p>)}
      {!allowed.length && <p>暂无持续授权</p>}
    </div>}
  </div>
}
