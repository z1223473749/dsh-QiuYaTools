import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Preferences } from '../../shared.ts'
import { gitAddress, parseGitAddress, type GitBranch, type GitCommit, type GitCredentialStatus, type GitFile, type GitProvider, type GitPullRequest, type GitReceipt, type GitRequest, type GitScope, type GitSnapshot } from './contract.ts'
import { createGitClientAPI, GitClientStore, type GitClientAPI, type GitConnection } from './client-api.ts'
import { createGitResourceProvider } from './resources.ts'
import { GitCounts, GitFileDiff, gitFileId } from './DiffView.tsx'
import { gitStyles } from './styles.ts'

const TAB_ID = 'qiuya-tools.git'
export interface GitClientOptions { preflightWorktree?(sessionId: string): Promise<void>; openWorktree?(sessionId: string, receipt: GitReceipt, ownership?: { sourceBlock?: object }): Promise<void>; worktreeAvailable?: boolean }
export interface GitClientFace { ctx: Context; form: ConfigForm<Preferences>; api: GitClientAPI; store: GitClientStore; options: GitClientOptions; open(sessionId: string, path?: string): void }
function useChinese(ctx: Context) { return useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot().active.startsWith('zh'), () => true) }
function useEnabled(form: ConfigForm<Preferences>) { return useSyncExternalStore(listener => form.subscribe(listener), () => { const value = form.getSnapshot(); return value.status === 'ready' && value.value?.enabled !== false && (value.value as Partial<Preferences> & { gitEnabled?: boolean } | undefined)?.gitEnabled !== false }, () => false) }
function useGitState(store: GitClientStore, sessionId: string, enabled = true, scope: GitScope = 'working', target?: string) {
  useEffect(() => enabled ? store.retain(sessionId, scope, target) : undefined, [store, sessionId, enabled, scope, target])
  return useSyncExternalStore(useCallback(listener => store.subscribe(sessionId, listener, scope, target), [store, sessionId, scope, target]), useCallback(() => store.snapshot(sessionId, scope, target), [store, sessionId, scope, target]), useCallback(() => store.snapshot(sessionId, scope, target), [store, sessionId, scope, target]))
}
export function GitBranchIcon() { return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><circle cx="4" cy="3" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="4" cy="13" r="1.6"/><path d="M4 4.6v6.8M12 5.6V7a3 3 0 0 1-3 3H7a3 3 0 0 0-3 2"/></svg> }
const Chevron = () => <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
function errorMessage(error: unknown, zh: boolean) { return error instanceof Error ? error.message : zh ? 'Git 操作失败，请刷新后重试。' : 'Git operation failed. Refresh and try again.' }
function sessionBranch(snapshot: GitSnapshot) { return snapshot.locked && snapshot.boundBranch !== undefined ? snapshot.boundBranch : snapshot.branch }
function usePopover(open: boolean, setOpen: (open: boolean) => void, side: 'top' | 'bottom' = 'top') {
  const root = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), restoringFocus = useRef(false)
  const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, side, align: 'start', gap: 8, margin: 12 })
  useDismissOnOutsidePointer(root, open, setOpen, panel)
  useEffect(() => { if (!open) return; const doc = anchor.current?.ownerDocument; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); setOpen(false); restoringFocus.current = true; anchor.current?.focus(); restoringFocus.current = false } }; doc?.addEventListener('keydown', escape); return () => doc?.removeEventListener('keydown', escape) }, [open, setOpen])
  return { root, anchor, panel, position, restoringFocus }
}

export function GitBranchSelector(props: PropsRuntime<'conversation.hero.options'> & InjectFace<GitClientFace>) {
  const enabled = useEnabled(props.form), zh = useChinese(props.ctx), state = useGitState(props.store, props.sessionId, enabled)
  const locked = props.useSession(session => !session.blank || session.awaitingFirstTurn || session.running)
  const unavailable = props.useSession(session => session.removed || session.subagent !== null || session.openState === 'loading' || session.openState === 'error')
  const submitting = props.useInput(input => input.phase === 'adjudicating' || input.phase === 'submitting')
  const snapshot = state.snapshot
  if (!enabled || !snapshot) return null
  if (!snapshot.available) {
    const reason = snapshot.reason?.trim(), notRepository = reason === '当前目录不是 Git 仓库。' || /^(?:fatal:\s*)?not a git repository\b/iu.test(reason ?? '')
    const label = notRepository ? zh ? '未检测到 Git 仓库' : 'No Git repository' : zh ? 'Git 不可用' : 'Git unavailable'
    return <div className="qyt-git-branch" data-qyt-git-branch={props.sessionId}><button type="button" className="qyt-git-branch-trigger" disabled aria-label={`${zh ? 'Git 分支' : 'Git branch'}：${label}`} title={reason || label}><GitBranchIcon/><span>{label}</span></button></div>
  }
  return <BranchPicker key={props.sessionId} {...props} snapshot={snapshot} locked={locked || snapshot.locked} disabled={unavailable || submitting || state.busy} zh={zh}/>
}
function BranchPicker({ snapshot, locked, disabled, zh, ...face }: GitClientFace & { snapshot: GitSnapshot; locked: boolean; disabled: boolean; zh: boolean }) {
  const [open, setOpen] = useState(false), [view, setView] = useState<'environment' | 'branches' | 'create'>('environment'), [branches, setBranches] = useState<GitBranch[]>([]), [loading, setLoading] = useState(false), [query, setQuery] = useState(''), [name, setName] = useState(''), [base, setBase] = useState(''), [mode, setMode] = useState<'current' | 'worktree'>('current'), [error, setError] = useState(''), [processing, setProcessing] = useState(false), [prepared, setPrepared] = useState<GitReceipt>()
  const popover = usePopover(open, setOpen, 'bottom'), titleId = useId(), mounted = useRef(true), inFlight = useRef(false), searchRef = useRef<HTMLInputElement>(null), nameRef = useRef<HTMLInputElement>(null), choosing = open && view !== 'environment'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (locked || disabled) setOpen(false) }, [locked, disabled])
  useEffect(() => { if (prepared) setView('environment') }, [prepared])
  useEffect(() => { if (!choosing || prepared) return; const controller = new AbortController(); setLoading(true); setError(''); void face.api.branches(snapshot.sessionId, controller.signal).then(value => { if (!controller.signal.aborted) setBranches(value) }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error, zh)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) }); return () => controller.abort() }, [choosing, prepared, face.api, snapshot.sessionId, zh])
  useEffect(() => { if (open) (view === 'branches' ? searchRef : view === 'create' ? nameRef : undefined)?.current?.focus() }, [open, view])
  const perform = async (op: GitRequest['op'], branch: string, selectedBase?: string) => {
    if (locked || disabled || inFlight.current) return
    inFlight.current = true; setProcessing(true); setError('')
    const blocks = face.ctx.conversation.blocks, blockKey = snapshot.sessionId as SessionId, ownedBlock = { reason: zh ? '正在准备 Git 分支…' : 'Preparing the Git branch…' }; let blocked = false
    try {
      if (op === 'createWorktree') await face.options.preflightWorktree?.(snapshot.sessionId)
      if (!mounted.current) return
      if (blocks.storeFor(blockKey).getSnapshot()) throw Error(zh ? '当前输入框正在处理其他操作，请稍后重试。' : 'Another operation is using the composer. Try again when it finishes.')
      blocks.set(blockKey, ownedBlock); blocked = true
      const receipt = prepared ?? await face.store.perform({ op, sessionId: snapshot.sessionId, branch, ...(selectedBase ? { base: selectedBase } : {}), expectedRevision: snapshot.revision })
      if (!mounted.current) return
      if (receipt.worktreePath) { setPrepared(receipt); if (!face.options.openWorktree) throw Error(zh ? '当前宿主尚不支持安全迁移工作树会话，请升级宿主。' : 'Update the Host to safely open a worktree session.'); await face.options.openWorktree(snapshot.sessionId, receipt, { sourceBlock: ownedBlock }) }
      if (mounted.current) { setPrepared(undefined); setName(''); setOpen(false) }
    } catch (error) { if (mounted.current) setError(errorMessage(error, zh)) } finally { inFlight.current = false; if (blocked && blocks.storeFor(blockKey).getSnapshot() === ownedBlock) blocks.set(blockKey, undefined); if (mounted.current) setProcessing(false) }
  }
  const busy = disabled || processing, label = snapshot.branch ?? (zh ? '游离 HEAD' : 'Detached HEAD'), filtered = branches.filter(branch => branch.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const triggerTitle = snapshot.bindingMismatch ? zh ? `会话绑定分支：${snapshot.boundBranch ?? 'HEAD'}；实际分支：${label}。请先恢复绑定分支。` : `Session branch: ${snapshot.boundBranch ?? 'HEAD'}; actual branch: ${label}. Restore the bound branch first.` : locked ? zh ? '会话已开始，分支已锁定。' : 'The session has started. Its branch is locked.' : zh ? '选择当前会话的 Git 分支' : 'Choose the Git branch for this session'
  return <div ref={popover.root} className="qyt-git-branch" data-qyt-git-branch={snapshot.sessionId}>
    <button type="button" ref={popover.anchor} className="qyt-git-branch-trigger" disabled={locked || busy} aria-haspopup="dialog" aria-expanded={open} aria-label={`${zh ? 'Git 分支' : 'Git branch'}：${label}`} title={triggerTitle} onClick={() => { if (!open) setView('environment'); setOpen(value => !value) }}><GitBranchIcon/><span>{label}</span>{snapshot.bindingMismatch && <span className="qyt-git-warning" aria-label={zh ? '分支与会话绑定不一致' : 'The branch differs from the session binding'}>!</span>}<Chevron/></button>
    {open && !locked && createPortal(<MenuSurface ref={popover.panel} role="dialog" aria-labelledby={titleId} className="qyt-git-surface qyt-git-branch-popover" data-view={view} style={{ position: 'fixed', ...popover.position, visibility: popover.position ? undefined : 'hidden' }}>
      {view === 'environment' ? <>
        <div id={titleId} className="qyt-git-environment-heading">{zh ? '配置本地环境' : 'Configure local environment'}</div>
        <button type="button" role="switch" aria-label={zh ? '新建工作树' : 'New worktree'} aria-checked={mode === 'worktree'} className="qyt-git-menu-row qyt-git-worktree-toggle" disabled={busy || !!prepared || !face.options.worktreeAvailable} title={!face.options.worktreeAvailable ? zh ? '需要支持工作树会话迁移的宿主版本。' : 'Requires a Host with worktree session migration.' : undefined} onClick={() => setMode(value => value === 'current' ? 'worktree' : 'current')}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M3 12.5h7.5V5M6.5 5h4V9M5 3H2v3M10.5 5 3 12.5"/></svg><span>{zh ? '新建工作树' : 'New worktree'}</span><span className="qyt-git-switch-track" aria-hidden="true"><span/></span></button>
        <button type="button" className="qyt-git-menu-row" aria-label={zh ? '选择分支' : 'Choose branch'} disabled={busy || !!prepared} onClick={() => setView('branches')}><GitBranchIcon/><span>{zh ? '分支' : 'Branch'}</span><span className="qyt-git-menu-value" title={label}>{label}</span><span className="qyt-git-menu-next" aria-hidden="true"><Chevron/></span></button>
        {prepared && <button type="button" className="qyt-git-primary qyt-git-prepared" disabled={busy} onClick={() => { void perform('createWorktree', prepared.branch ?? '') }}>{processing ? zh ? '正在准备…' : 'Preparing…' : zh ? '打开已创建的工作树' : 'Open prepared worktree'}</button>}
      </> : <>
        <button type="button" className="qyt-git-menu-back" aria-label={view === 'branches' ? zh ? '返回本地环境' : 'Back to local environment' : zh ? '返回分支列表' : 'Back to branches'} onClick={() => setView(view === 'branches' ? 'environment' : 'branches')}><span aria-hidden="true"><Chevron/></span><span id={titleId}>{view === 'branches' ? zh ? '分支' : 'Branches' : zh ? '新建分支' : 'New branch'}</span></button>
        {view === 'branches' ? <>
          <input ref={searchRef} type="search" className="qyt-git-search" aria-label={zh ? '搜索分支' : 'Search branches'} placeholder={zh ? '搜索分支…' : 'Search branches…'} value={query} onChange={event => setQuery(event.target.value)}/>
          <div className="qyt-git-branches" role="listbox" aria-label={zh ? 'Git 分支' : 'Git branches'}>{loading ? <p className="qyt-git-note" role="status">{zh ? '正在读取分支…' : 'Loading branches…'}</p> : <>{(['local', 'remote'] as const).map(group => <React.Fragment key={group}><div className="qyt-git-group-label">{group === 'local' ? zh ? '本地分支' : 'Local branches' : zh ? '远程分支' : 'Remote branches'}</div>{filtered.filter(branch => branch.remote === (group === 'remote')).map(branch => <button type="button" role="option" aria-selected={branch.current} key={branch.ref} disabled={busy || !!prepared || mode === 'current' && branch.current || mode === 'worktree' && branch.checkedOut} title={mode === 'worktree' && branch.checkedOut ? zh ? '此分支已被其他工作树使用，可自定义名称新建分支。' : 'This branch is already checked out. Create a branch with a custom name.' : branch.name} onClick={() => { if (mode === 'worktree') { const remote = snapshot.remotes.find(remote => branch.name.startsWith(`${remote.name}/`)), localName = branch.remote ? branch.name.slice(remote ? remote.name.length + 1 : branch.name.indexOf('/') + 1) : branch.name; void perform('createWorktree', localName, branch.ref) } else void perform('selectBranch', branch.ref) }}><GitBranchIcon/><span title={branch.name}>{branch.name}</span>{branch.current && <span aria-hidden="true">✓</span>}</button>)}</React.Fragment>)}{!filtered.length && !error && <p className="qyt-git-note">{zh ? '没有匹配的分支' : 'No matching branches'}</p>}</>}</div>
          <div className="qyt-git-menu-footer"><button type="button" className="qyt-git-menu-row" disabled={busy || !!prepared} onClick={() => setView('create')}><span aria-hidden="true">＋</span><span>{zh ? '新建分支…' : 'New branch…'}</span></button></div>
        </> : <form className="qyt-git-create-branch" onSubmit={event => { event.preventDefault(); if (prepared) void perform('createWorktree', prepared.branch ?? ''); else if (name.trim()) void perform(mode === 'worktree' ? 'createWorktree' : 'createBranch', name.trim(), base || snapshot.branch || undefined) }}>
        <label>{zh ? '新分支名称' : 'New branch name'}<input ref={nameRef} value={name} onChange={event => setName(event.target.value)} placeholder={zh ? '自定义分支名称' : 'Custom branch name'} maxLength={1024} disabled={busy || !!prepared}/></label>
        <label>{zh ? '基于分支' : 'Base branch'}<select aria-label={zh ? '基于分支' : 'Base branch'} value={base} disabled={busy || !!prepared} onChange={event => setBase(event.target.value)}><option value="">{snapshot.branch ?? 'HEAD'}</option>{branches.map(branch => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}</select></label>
        <button type="submit" className="qyt-git-primary" disabled={busy || !prepared && !name.trim()}>{processing ? zh ? '正在准备…' : 'Preparing…' : prepared ? zh ? '打开已创建的工作树' : 'Open prepared worktree' : zh ? '创建并使用' : 'Create and use'}</button>
        </form>}
      </>}
      {error && <p className="qyt-git-error" role="alert">{error}</p>}
    </MenuSurface>, popover.anchor.current?.ownerDocument.body ?? document.body)}
  </div>
}

export function GitStats(props: PropsRuntime<'conversation.composer.dock'> & InjectFace<GitClientFace>) {
  const enabled = useEnabled(props.form), zh = useChinese(props.ctx), state = useGitState(props.store, props.sessionId, enabled)
  const [open, setOpen] = useState(false), closeTimer = useRef<ReturnType<typeof setTimeout>>(), popover = usePopover(open, setOpen), titleId = useId()
  const keep = () => { clearTimeout(closeTimer.current); setOpen(true) }, leave = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 150) }
  useEffect(() => { setOpen(false); return () => clearTimeout(closeTimer.current) }, [props.sessionId, enabled])
  const snapshot = state.snapshot
  if (!enabled || snapshot && !snapshot.available) return null
  if (!snapshot) return state.error ? <button type="button" className="qyt-git-stats qyt-git-failed" title={state.error} onClick={() => { void props.store.refresh(props.sessionId) }}>{zh ? 'Git 读取失败 · 重试' : 'Git unavailable · Retry'}</button> : null
  return <div ref={popover.root} className="qyt-git-stats-seat" data-qyt-git-stats={props.sessionId} onMouseEnter={keep} onMouseLeave={leave}>
    <button ref={popover.anchor} type="button" className="qyt-git-stats" aria-haspopup="dialog" aria-expanded={open} aria-label={`${snapshot.repoName} Git ${zh ? '改动' : 'changes'}: +${snapshot.added} -${snapshot.deleted} ${snapshot.fileCount} ${zh ? '个文件' : 'files'}`} title={state.error ?? (zh ? '点击查看 Git 对比' : 'Click to view Git differences')} onFocus={() => { if (!popover.restoringFocus.current) keep() }} onBlur={leave} onClick={() => { setOpen(false); props.open(props.sessionId) }}><GitCounts added={snapshot.added} deleted={snapshot.deleted}/><span>{snapshot.fileCount} {zh ? '个文件' : 'files'}</span>{(state.error || snapshot.bindingMismatch) && <span className="qyt-git-warning" aria-label={zh ? 'Git 状态需要检查' : 'Git status needs attention'}>!</span>}</button>
    {open && createPortal(<MenuSurface ref={popover.panel} role="dialog" aria-labelledby={titleId} className="qyt-git-surface qyt-git-stats-popover" data-qyt-git-hover={props.sessionId} style={{ position: 'fixed', ...popover.position, visibility: popover.position ? undefined : 'hidden' }} onMouseEnter={keep} onMouseLeave={leave} onFocus={keep} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave() }}>
      <div className="qyt-git-popover-heading"><strong id={titleId} title={snapshot.repoRoot}>{snapshot.repoName}</strong><span className="qyt-git-caption">{sessionBranch(snapshot) ?? 'HEAD'}</span></div>
      <div className="qyt-git-hover-files">{snapshot.files.length ? snapshot.files.map(file => <button type="button" key={file.path} className="qyt-git-hover-file" title={file.path} onClick={() => { setOpen(false); props.open(props.sessionId, file.path) }}><span>{file.path}</span><GitCounts added={file.added} deleted={file.deleted}/></button>) : <p className="qyt-git-note">{zh ? '没有未提交改动' : 'No uncommitted changes'}</p>}</div>
      {state.error && <p className="qyt-git-error" role="status">{state.error}</p>}
    </MenuSurface>, popover.anchor.current?.ownerDocument.body ?? document.body)}
  </div>
}

function remoteProvider(url: string): GitProvider | undefined { const value = url.toLowerCase(); return /(?:^|[@/])github\.com[:/]/u.test(value) ? 'github' : /(?:^|[@/])gitlab\.com[:/]/u.test(value) ? 'gitlab' : /(?:^|[@/])gitee\.com[:/]/u.test(value) ? 'gitee' : undefined }
function RecentCommits({ api, snapshot, zh }: { api: GitClientAPI; snapshot: GitSnapshot; zh: boolean }) {
  const [open, setOpen] = useState(false), [rows, setRows] = useState<GitCommit[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    const controller = new AbortController(); setLoading(true); setError('')
    void api.log(snapshot.sessionId, controller.signal).then(value => { if (!controller.signal.aborted) setRows(value) }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error, zh)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, snapshot.sessionId, snapshot.head, open, zh])
  return <details className="qyt-git-history" onToggle={event => setOpen(event.currentTarget.open)}><summary>{zh ? '最近提交' : 'Recent commits'}</summary>{open && <div className="qyt-git-history-list">{loading ? <p className="qyt-git-caption">{zh ? '正在读取…' : 'Loading…'}</p> : error ? <p className="qyt-git-error" role="alert">{error}</p> : rows.length ? rows.map(row => <div key={row.hash} className="qyt-git-history-item"><code title={row.hash} tabIndex={0}>{row.shortHash}</code><span title={row.subject}>{row.subject}</span><small title={new Date(row.at).toLocaleString(zh ? 'zh-CN' : 'en-US')}>{row.author}</small></div>) : <p className="qyt-git-caption">{zh ? '此仓库还没有提交。' : 'This repository has no commits yet.'}</p>}</div>}</details>
}
interface FileTreeNode { path: string; name: string; children: Map<string, FileTreeNode>; file?: GitFile }
function GitFileTree({ files, active, choose, zh, searching }: { files: GitFile[]; active?: string; choose(path: string): void; zh: boolean; searching: boolean }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const tree = useMemo(() => {
    const root: FileTreeNode = { path: '', name: '', children: new Map() }
    for (const file of files) { let node = root; const segments = file.path.split('/'); for (let index = 0; index < segments.length; index++) { const name = segments[index]!, path = segments.slice(0, index + 1).join('/'); let child = node.children.get(name); if (!child) { child = { name, path, children: new Map() }; node.children.set(name, child) } node = child } node.file = file }
    return root
  }, [files])
  const render = (node: FileTreeNode, depth: number): React.ReactNode => [...node.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)).map(child => {
    if (child.file) { const file = child.file; return <button type="button" key={file.path} className="qyt-git-tree-file" style={{ paddingInlineStart: 5 + depth * 12 }} aria-current={file.path === active ? 'true' : undefined} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => choose(file.path)}><span>{child.name}</span><GitCounts added={file.added} deleted={file.deleted}/><span className="qyt-git-status" title={file.status}>{file.status === 'untracked' ? '?' : file.status[0]!.toUpperCase()}</span>{file.staged && <span className="qyt-git-status" title={zh ? '已暂存' : 'Staged'}>✓</span>}</button> }
    const open = searching || !collapsed.has(child.path)
    return <React.Fragment key={child.path}><button type="button" className="qyt-git-tree-directory" style={{ paddingInlineStart: 5 + depth * 12 }} aria-expanded={open} title={child.path} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(child.path)) next.delete(child.path); else next.add(child.path); return next })}><span aria-hidden="true">{open ? '▾' : '▸'}</span>{child.name}</button>{open && render(child, depth + 1)}</React.Fragment>
  })
  return <div className="qyt-git-file-list" role="navigation" aria-label={zh ? '已更改的文件' : 'Changed files'}>{render(tree, 0)}</div>
}
function PullRequests({ face, snapshot, zh, disabled }: { face: GitClientFace; snapshot: GitSnapshot; zh: boolean; disabled: boolean }) {
  const remoteNames = snapshot.remotes.filter(remote => remoteProvider(remote.url)), [remote, setRemote] = useState(remoteNames.find(value => value.name === 'origin')?.name ?? remoteNames[0]?.name ?? ''), [credential, setCredential] = useState<GitCredentialStatus>(), [token, setToken] = useState(''), [rows, setRows] = useState<GitPullRequest[]>([]), [title, setTitle] = useState(''), [body, setBody] = useState(''), [target, setTarget] = useState(snapshot.defaultTarget?.replace(/^[^/]+\//u, '') ?? ''), [draft, setDraft] = useState(false), [selected, setSelected] = useState<number>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const mounted = useRef(true), generation = useRef(0), controllers = useRef(new Set<AbortController>())
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear() } }, [])
  const provider = remoteProvider(snapshot.remotes.find(value => value.name === remote)?.url ?? '')
  useEffect(() => { if (!remoteNames.some(value => value.name === remote)) setRemote(remoteNames[0]?.name ?? '') }, [snapshot.remotes, remote])
  useEffect(() => {
    const controller = new AbortController(), version = ++generation.current; controllers.current.add(controller); setToken(''); setCredential(undefined); setRows([]); setError(''); setNotice(''); setSelected(undefined); setBusy(false)
    if (remote && provider) void face.api.credential({ op: 'credentialStatus', sessionId: snapshot.sessionId, remote, provider }, controller.signal).then(value => { if (mounted.current && !controller.signal.aborted && version === generation.current) setCredential(value) }).catch(error => { if (mounted.current && !controller.signal.aborted && version === generation.current) setError(errorMessage(error, zh)) })
    return () => { controller.abort(); controllers.current.delete(controller) }
  }, [face.api, snapshot.sessionId, remote, provider, zh])
  const action = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (busy || disabled) return
    const controller = new AbortController(), version = generation.current; controllers.current.add(controller); setBusy(true); setError(''); setNotice('')
    try { await face.store.run(snapshot.sessionId, signal => work(AbortSignal.any([signal, controller.signal]))) } catch (error) { if (mounted.current && !controller.signal.aborted && version === generation.current) setError(errorMessage(error, zh)) } finally { controllers.current.delete(controller); if (mounted.current && version === generation.current) setBusy(false) }
  }
  const current = (signal: AbortSignal) => mounted.current && !signal.aborted
  const refresh = (signal: AbortSignal) => face.api.pullRequests({ op: 'prList', sessionId: snapshot.sessionId, remote, provider, ...(snapshot.branch ? { sourceBranch: snapshot.branch } : {}) }, signal).then(value => { if (current(signal)) setRows(value) })
  const blocked = busy || disabled
  return <section className="qyt-git-pr" aria-label={zh ? 'PR 与账户' : 'Pull requests and account'}><h3>{provider === 'gitlab' ? 'Merge Request' : 'Pull Request'}</h3>
    {!remoteNames.length ? <p className="qyt-git-note">{zh ? '请先在仓库中配置 GitHub、GitLab 或 Gitee 远程地址。' : 'Configure a GitHub, GitLab, or Gitee remote first.'}</p> : <>
      <label>{zh ? '远程仓库' : 'Remote repository'}<select value={remote} disabled={blocked} onChange={event => setRemote(event.target.value)}>{remoteNames.map(value => <option key={value.name} value={value.name}>{value.name} · {remoteProvider(value.url)}</option>)}</select></label>
      <details className="qyt-git-credentials"><summary>{credential?.configured ? zh ? '平台访问令牌已配置' : 'Platform token configured' : zh ? '配置平台访问令牌' : 'Configure platform token'}</summary><p className="qyt-git-caption">{zh ? 'PR 使用平台令牌；Git 推送使用系统 Git 已有的 SSH 或凭据。' : 'PRs use the platform token; pushes use your existing Git SSH or credentials.'}</p><label>{zh ? '访问令牌' : 'Access token'}<input type="password" autoComplete="off" value={token} disabled={blocked} onChange={event => setToken(event.target.value)} maxLength={8192}/></label><div className="qyt-git-buttons"><button type="button" disabled={blocked || !token.trim() || credential?.writable === false} onClick={() => { const value = token; setToken(''); void action(async signal => { await face.api.perform({ op: 'credentialSet', sessionId: snapshot.sessionId, remote, provider, token: value }, signal); const result = await face.api.credential({ op: 'credentialStatus', sessionId: snapshot.sessionId, remote, provider }, signal); if (current(signal)) { setCredential(result); setNotice(zh ? '访问令牌已保存。' : 'Access token saved.') } }) }}>{zh ? '保存令牌' : 'Save token'}</button>{credential?.configured && <button type="button" disabled={blocked || !credential.writable} onClick={() => { void action(async signal => { await face.api.perform({ op: 'credentialRemove', sessionId: snapshot.sessionId, remote, provider }, signal); const result = await face.api.credential({ op: 'credentialStatus', sessionId: snapshot.sessionId, remote, provider }, signal); if (current(signal)) setCredential(result) }) }}>{zh ? '移除令牌' : 'Remove token'}</button>}</div></details>
      <button type="button" disabled={blocked || !credential?.configured || !snapshot.branch} onClick={() => { void action(refresh) }}>{zh ? '读取当前分支 PR' : 'Load branch pull requests'}</button>
      <div className="qyt-git-pr-list">{rows.map(row => <div key={`${row.provider}-${row.number}`} className="qyt-git-pr-item"><a href={row.url} target="_blank" rel="noopener noreferrer">#{row.number} {row.title}</a><span className="qyt-git-caption">{row.state} · {row.sourceBranch} → {row.targetBranch} · CI: {row.checkStatus === 'unknown' ? zh ? '未提供' : 'unavailable' : row.checkStatus}{row.reviewStatus ? ` · ${row.reviewStatus}` : ''}{row.mergeStatus ? ` · ${row.mergeStatus}` : ''}</span><button type="button" disabled={blocked} onClick={() => { setSelected(row.number); setTitle(row.title); setBody(row.body); setTarget(row.targetBranch); setDraft(row.draft ?? false) }}>{zh ? '编辑' : 'Edit'}</button></div>)}</div>
      <form onSubmit={event => { event.preventDefault(); void action(async signal => { const result = await face.api.pullRequest({ op: selected ? 'prUpdate' : 'prCreate', sessionId: snapshot.sessionId, remote, provider, title: title.trim(), body, ...(!selected || provider !== 'gitee' ? { targetBranch: target.trim() } : {}), ...(selected ? { number: selected } : { sourceBranch: snapshot.branch ?? '', draft }), requestId: globalThis.crypto.randomUUID() }, signal); if (current(signal)) { setSelected(result.number); setNotice(`${zh ? '已确认' : 'Confirmed'} #${result.number}`); setRows(previous => [result, ...previous.filter(row => row.number !== result.number)]) } }) }}>
        <label>{zh ? '目标分支' : 'Target branch'}<input value={target} disabled={blocked || !!selected && provider === 'gitee'} onChange={event => setTarget(event.target.value)} placeholder="main" maxLength={1024}/></label><label>{zh ? '标题' : 'Title'}<input value={title} disabled={blocked} onChange={event => setTitle(event.target.value)} maxLength={4096}/></label><label>{zh ? '说明' : 'Description'}<textarea value={body} disabled={blocked} onChange={event => setBody(event.target.value)} rows={4} maxLength={32_000}/></label>
        {!selected && <label className="qyt-git-check"><input type="checkbox" checked={draft} disabled={blocked} onChange={event => setDraft(event.target.checked)}/>{zh ? '创建为草稿' : 'Create as draft'}</label>}
        <div className="qyt-git-buttons"><button type="submit" className="qyt-git-primary" disabled={blocked || !credential?.configured || !snapshot.branch || !title.trim() || !target.trim()}>{busy ? zh ? '正在处理…' : 'Working…' : selected ? zh ? `更新 #${selected}` : `Update #${selected}` : zh ? '创建 PR / MR' : 'Create PR / MR'}</button>{selected && <button type="button" disabled={blocked} onClick={() => { setSelected(undefined); setTitle(''); setBody('') }}>{zh ? '新建另一份' : 'New request'}</button>}</div>
      </form>
    </>}{notice && <p className="qyt-git-note" role="status">{notice}</p>}{error && <p className="qyt-git-error" role="alert">{error}</p>}
  </section>
}

export function GitDetails(props: PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<GitClientFace>) {
  const info = props.useTabInfo(), address = parseGitAddress(info.tab.navigation.address), zh = useChinese(props.ctx), enabled = useEnabled(props.form)
  const [scope, setScope] = useState<GitScope>('working'), [target, setTarget] = useState(''), [split, setSplit] = useState(false), [filter, setFilter] = useState(''), [selected, setSelected] = useState<string>(), [message, setMessage] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [showPR, setShowPR] = useState(false)
  const state = useGitState(props.store, props.sessionId, enabled && address?.sessionId === props.sessionId, scope, scope === 'branch' ? target || undefined : undefined), snapshot = state.snapshot, root = useRef<HTMLDivElement>(null), mounted = useRef(true), generation = useRef(0)
  const navigation = useSyncExternalStore(useCallback(listener => props.store.subscribeOpen(props.sessionId, listener), [props.store, props.sessionId]), useCallback(() => props.store.openRequest(props.sessionId), [props.store, props.sessionId]))
  const running = props.useSession(session => session.running || session.removed || session.subagent !== null || session.openState !== 'open')
  const submitting = props.useInput(input => input.phase === 'adjudicating' || input.phase === 'submitting')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { generation.current++; setError(''); setNotice(''); setMessage(''); setScope('working'); setTarget(''); setFilter(''); setShowPR(false) }, [props.sessionId])
  useEffect(() => { setSelected(address?.path) }, [info.tab.navigation.address])
  useEffect(() => { if (navigation.version) { setScope('working'); setTarget(''); setSelected(navigation.path) } }, [navigation.version, navigation.path])
  useEffect(() => { if (!selected || !root.current) return; const element = [...root.current.querySelectorAll<HTMLElement>('[data-git-path]')].find(element => element.dataset.gitPath === selected); element?.scrollIntoView?.({ block: 'start' }) }, [selected, snapshot?.files])
  useEffect(() => info.tab.actions.bindCommands({ refresh: () => { void props.store.refreshSession(props.sessionId) } }), [info.tab.actions, props.store, props.sessionId])
  const perform = async (op: GitRequest['op'], fields: Partial<GitRequest> = {}) => {
    if (!snapshot || state.busy || running || submitting || snapshot.bindingMismatch) return
    const version = generation.current
    setError(''); setNotice('')
    try { const receipt = await props.store.perform({ ...fields, op, sessionId: props.sessionId, scope: snapshot.scope, ...(snapshot.target ? { target: snapshot.target } : {}), expectedRevision: snapshot.revision }); if (mounted.current && version === generation.current) { setNotice(receipt.message); if (op === 'commit') setMessage('') } } catch (error) { if (mounted.current && version === generation.current) setError(errorMessage(error, zh)) }
  }
  if (!address || address.sessionId !== props.sessionId) return <p className="qyt-git-error">{zh ? '此 Git 对比属于其他会话。' : 'This Git comparison belongs to another session.'}</p>
  if (!enabled) return <p className="qyt-git-note">{zh ? 'Git 功能已关闭。' : 'Git is disabled.'}</p>
  if (!snapshot) return <p className={state.error ? 'qyt-git-error' : 'qyt-git-note'} role="status">{state.error ?? (zh ? '正在读取 Git 改动…' : 'Loading Git changes…')}</p>
  if (!snapshot.available) return <p className="qyt-git-note">{snapshot.reason ?? (zh ? '此目录不是 Git 仓库。' : 'This directory is not a Git repository.')}</p>
  const disabled = state.busy || running || submitting || snapshot.bindingMismatch, filtered = snapshot.files.filter(file => file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), active = selected ?? filtered[0]?.path
  const choose = (path: string) => { setSelected(path); const element = root.current?.ownerDocument.getElementById(gitFileId(path)); if (root.current?.contains(element ?? null)) element?.scrollIntoView?.({ block: 'start' }) }
  const step = (direction: number) => { const index = filtered.findIndex(file => file.path === active); const file = filtered[Math.min(filtered.length - 1, Math.max(0, index + direction))]; if (file) choose(file.path) }
  return <div ref={root} className="qyt-git-pane" data-qyt-git-details={props.sessionId}>
    <header className="qyt-git-toolbar"><strong title={snapshot.repoRoot}>{snapshot.repoName}</strong><span className="qyt-git-branch-badge"><GitBranchIcon/>{sessionBranch(snapshot) ?? 'HEAD'}</span><GitCounts added={snapshot.added} deleted={snapshot.deleted}/><span className="qyt-git-caption">{snapshot.fileCount} {zh ? '个文件' : 'files'}</span><button type="button" disabled={state.busy} onClick={() => { void props.store.refreshSession(props.sessionId) }}>{zh ? '刷新' : 'Refresh'}</button></header>
    <div className="qyt-git-compare-tools"><select aria-label={zh ? '对比范围' : 'Comparison scope'} value={scope} onChange={event => { setScope(event.target.value as GitScope); setSelected(undefined) }}><option value="working">{zh ? '未提交改动' : 'Uncommitted changes'}</option><option value="staged">{zh ? '已暂存' : 'Staged'}</option><option value="unstaged">{zh ? '未暂存' : 'Unstaged'}</option><option value="branch">{zh ? '分支对比' : 'Branch comparison'}</option></select>{scope === 'branch' && <label className="qyt-git-target">→ <input aria-label={zh ? '对比目标分支' : 'Comparison target branch'} value={target} onChange={event => setTarget(event.target.value)} placeholder={snapshot.defaultTarget ?? 'origin/main'} maxLength={1024}/></label>}<button type="button" aria-pressed={split} onClick={() => setSplit(value => !value)}>{split ? zh ? '左右对照' : 'Side by side' : zh ? '统一视图' : 'Unified'}</button><button type="button" disabled={!filtered.length} onClick={() => step(-1)} aria-label={zh ? '上一个文件' : 'Previous file'}>↑</button><button type="button" disabled={!filtered.length} onClick={() => step(1)} aria-label={zh ? '下一个文件' : 'Next file'}>↓</button></div>
    {snapshot.bindingMismatch && <div className="qyt-git-error" role="alert">{zh ? `会话分支：${snapshot.boundBranch ?? 'HEAD'}；实际分支：${snapshot.branch ?? 'HEAD'}。请恢复绑定分支后继续。` : `Session branch: ${snapshot.boundBranch ?? 'HEAD'}; actual branch: ${snapshot.branch ?? 'HEAD'}. Restore the bound branch to continue.`}<button type="button" disabled={state.busy || running || submitting} onClick={() => { const version = generation.current; setError(''); void props.store.perform({ op: 'restoreBinding', sessionId: props.sessionId, scope: snapshot.scope, ...(snapshot.target ? { target: snapshot.target } : {}), expectedRevision: snapshot.revision }).catch(error => { if (mounted.current && version === generation.current) setError(errorMessage(error, zh)) }) }}>{zh ? '恢复绑定分支' : 'Restore bound branch'}</button></div>}
    {(error || state.error) && <p className="qyt-git-error" role="alert">{error || state.error}</p>}{notice && <p className="qyt-git-note" role="status">{notice}</p>}
    <div className="qyt-git-workspace"><main className="qyt-git-differences">{filtered.length ? filtered.map(file => <GitFileDiff key={`${snapshot.scope}-${snapshot.target ?? ''}-${file.path}`} file={file} snapshot={snapshot} api={props.api} split={split} selected={file.path === active} zh={zh} onStage={scope !== 'branch' && !disabled ? file => { void perform(scope === 'staged' || scope !== 'unstaged' && file.staged && !file.unstaged ? 'unstage' : 'stage', { paths: [file.path] }) } : undefined}/>) : <p className="qyt-git-note">{filter ? zh ? '没有匹配的文件。' : 'No matching files.' : zh ? '当前范围没有改动。' : 'No changes in this comparison.'}</p>}</main>
      <aside className="qyt-git-file-tree"><input type="search" className="qyt-git-search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={zh ? '筛选文件…' : 'Filter files…'} aria-label={zh ? '筛选文件' : 'Filter files'}/><GitFileTree key={props.sessionId} files={filtered} active={active} choose={choose} zh={zh} searching={!!filter}/></aside>
    </div>
    <div className="qyt-git-actions"><div className="qyt-git-buttons"><button type="button" disabled={disabled || scope === 'branch' || !snapshot.files.some(file => file.unstaged || file.status === 'untracked')} onClick={() => { void perform('stage') }}>{zh ? '全部暂存' : 'Stage all'}</button><button type="button" disabled={disabled || scope === 'branch' || !snapshot.files.some(file => file.staged)} onClick={() => { void perform('unstage') }}>{zh ? '全部取消暂存' : 'Unstage all'}</button><button type="button" disabled={disabled} onClick={() => { void perform('fetch') }}>Fetch</button><button type="button" disabled={disabled} onClick={() => { void perform('pull') }}>Pull</button><button type="button" disabled={disabled} onClick={() => { void perform('push') }}>Push{snapshot.ahead ? ` ↑${snapshot.ahead}` : ''}</button><button type="button" aria-expanded={showPR} onClick={() => setShowPR(value => !value)}>PR / MR</button><span className="qyt-git-caption">{snapshot.upstream ? `${snapshot.upstream} · ↑${snapshot.ahead} ↓${snapshot.behind}` : zh ? '未设置上游分支' : 'No upstream branch'}</span></div><form className="qyt-git-commit" onSubmit={event => { event.preventDefault(); if (message.trim()) void perform('commit', { message: message.trim() }) }}><input aria-label={zh ? '提交说明' : 'Commit message'} placeholder={zh ? '填写提交说明…' : 'Commit message…'} value={message} onChange={event => setMessage(event.target.value)} disabled={disabled} maxLength={16_000}/><button type="submit" className="qyt-git-primary" disabled={disabled || !message.trim()}>{state.busy ? zh ? '处理中…' : 'Working…' : zh ? '提交暂存改动' : 'Commit staged changes'}</button></form></div>
    <RecentCommits key={`${props.sessionId}-history`} api={props.api} snapshot={snapshot} zh={zh}/>
    {showPR && <PullRequests key={props.sessionId} face={props} snapshot={snapshot} zh={zh} disabled={disabled}/>}
  </div>
}

/** All controls are supplied their exact Session by public slots, including detached chat windows. */
export function installGitClient(ctx: Context, form: ConfigForm<Preferences>, options: GitClientOptions = {}): () => void {
  const api = createGitClientAPI(() => ctx.get('connection') as GitConnection | undefined), store = new GitClientStore(api), disposers: (() => void)[] = []; let disposed = false
  const face: GitClientFace = { ctx, form, api, store, options, open(sessionId, path) { if (disposed || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return; store.requestOpen(sessionId, path); ctx.sidebarRight.openResource(gitAddress(sessionId, path)) } }
  try {
    disposers.push(ctx.resources.register(createGitResourceProvider()))
    disposers.push(ctx.sidebarRightTabs.register({ id: TAB_ID, kind: 'qiuya-git', patterns: ['dsh-resource://qiuya-git/**'], canOpen: address => parseGitAddress(address) !== undefined, title: () => ctx.locale.getSnapshot().active.startsWith('zh') ? 'Git 改动' : 'Git changes', multiple: false, keepMounted: false }))
    disposers.push(ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'qiuya-tools-git-branch', order: 10, inject: () => face }, GitBranchSelector)))
    disposers.push(ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'qiuya-tools-git-stats', order: 999, inject: () => face }, GitStats)))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => face }, GitDetails)))
    const style = document.createElement('style'); style.dataset.plugin = 'qiuya-tools-git'; style.textContent = gitStyles; document.head.append(style); disposers.push(() => style.remove())
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); store.dispose(); throw error }
  return () => { if (disposed) return; disposed = true; store.dispose(); for (const dispose of disposers.reverse()) dispose() }
}
