import type { Context } from '@deepseek-ai/cordis'
import { GitError, type GitReceipt } from './contract.ts'
import { hostServiceIdentity } from '../../host-service-identity.ts'

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Draft { draft: string; draftRev: number; attachmentIds: readonly string[]; phase: string; claim?: unknown; occurrences: readonly unknown[]; queue: readonly unknown[] }
interface Input { state: Source<Draft>; setDraft(text: string): void; addAttachments(ids: readonly string[]): boolean; removeAttachment(id: string): boolean }
interface Model { provider: string; model: string; reasoningEffort?: string }
interface SessionState { blank: boolean; running: boolean; removed: boolean; subagent: unknown; openState: string; pendingSubmissions: readonly unknown[]; awaitingFirstTurn: boolean }
interface Session extends Source<SessionState> { projections: { faceOf(key: string): Source<unknown> }; command(line: string): Promise<Result<{ matched: boolean }>> }
interface Binding { sessionId: string; ctx: unknown; session: Session }
interface Reference { binding: Binding; ready: Promise<Binding>; release(): void }
interface SessionCatalog { phase: string; byId: Record<string, { cwd?: string; projectionValues?: Record<string, unknown> }> }
interface Result<T> { ok: boolean; value?: T; error?: unknown }
interface Block { reason: string }
interface Services {
  sessions: { list: Source<SessionCatalog>; create(options: { workspaceId: string; agentPreset?: string }): Promise<string>; retain(id: string, options: { source: 'workspaceOperation'; signal: AbortSignal }): Reference; binding(id: string): Binding | undefined; refreshProjections(id: string): Promise<void> }
  conversation: { input: { for(ctx: unknown): Input; requestDraftInitialization(binding: Binding, options: { prompt: string; clearPreviousDraft: boolean }): 'applied' | 'preserved' | 'blocked' }; blocks: { set(id: string, block: Block | undefined): void; storeFor(id: string): Source<Block | undefined> }; rebindDraftFiles(id: string, ids: readonly string[]): void; resolveDraftAttachments(ids: readonly string[]): readonly { id: string }[] }
  workspaces: { create(input: { path: string }): Promise<{ workspaceId: string; path: string }>; rename?(id: string, title: string): Promise<unknown> }
  navigation: { openSession(id: string): void }
  current: Source<{ key?: string }>
  connection: { generation: Source<unknown> }
  remote: { session: { modelCatalog(): Promise<Result<{ default: Model }>>; selectModel(request: Model & { sessionId: string }): Promise<Result<{ selected: Model }>> } }
  modelDirectories?: { directoryFor(id: string): { store: Source<{ pending?: unknown; status?: string }> } }
}
interface Prepared { services: Services; binding: Binding; input: Input; draft: Draft; model: Model; modelProjection: string; permission: string | undefined; permissionProjection: string; preset: string | undefined; connectionGeneration: unknown }
export interface GitWorktreeNavigation {
  readonly available: boolean
  /** Read-only checks and a revision capture; call before creating a worktree or raising a UI block. */
  preflight(sessionId: string): Promise<void>
  openWorktree(sessionId: string, receipt: GitReceipt, ownership?: { sourceBlock?: object }): Promise<void>
  dispose(): void
}

const changed = () => new GitError('WORKTREE_STATE_CHANGED', '会话或草稿已变化，请在当前会话重试；已经准备的工作树目录会保留。')
const unsupported = () => new GitError('WORKTREE_NAVIGATION_UNAVAILABLE', '当前宿主未提供完整的工作树会话迁移能力，请升级宿主后再使用独立工作树。')
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
const functions = (value: unknown, names: readonly string[]) => names.every(name => typeof object(value)[name] === 'function')
const serial = (value: unknown) => JSON.stringify(value) ?? 'undefined'
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => right[index] === id)
const pathKey = (path: string) => /^[a-z]:[\\/]/iu.test(path) ? path.replace(/\\/gu, '/').toLowerCase() : path

function discover(ctx: Context): Services | undefined {
  try {
    const sessions = ctx.get('sessions'), conversation = ctx.get('conversation'), workspaces = ctx.get('workspaces'), navigation = ctx.get('uiWorkspace'), ui = object(ctx.get('uiSession')), connection = ctx.get('connection'), remote = ctx.get('remote'), current = object(ui.adapter).current
    if (!functions(sessions, ['create', 'retain', 'binding', 'refreshProjections']) || !functions(object(sessions).list, ['getSnapshot', 'subscribe']) || !functions(conversation, ['rebindDraftFiles', 'resolveDraftAttachments']) || !functions(object(conversation).input, ['for', 'requestDraftInitialization']) || !functions(object(conversation).blocks, ['set', 'storeFor']) || !functions(workspaces, ['create']) || !functions(navigation, ['openSession']) || !functions(current, ['getSnapshot', 'subscribe']) || !functions(object(connection).generation, ['getSnapshot', 'subscribe']) || !functions(object(remote).session, ['modelCatalog', 'selectModel'])) return
    const modelDirectories = ctx.get('modelDirectories')
    return { sessions, conversation, workspaces, navigation, current, connection, remote, ...(functions(modelDirectories, ['directoryFor']) ? { modelDirectories } : {}) } as unknown as Services
  } catch { return }
}

function selection(value: unknown): Model {
  const row = object(value)
  if (typeof row.provider !== 'string' || !row.provider || typeof row.model !== 'string' || !row.model || row.reasoningEffort !== undefined && typeof row.reasoningEffort !== 'string') throw unsupported()
  return { provider: row.provider, model: row.model, ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort as string }) }
}

function permissionOf(value: unknown): string | undefined {
  if (value === undefined) return
  const current = object(value).currentValue
  if (current === 'custom') throw new GitError('WORKTREE_CUSTOM_PERMISSION', '当前会话使用自定义权限，暂时无法完整迁移。请在当前目录继续，或先选择一个权限预设。')
  if (typeof current !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(current)) throw unsupported()
  return current
}

function assertBlank(binding: Binding) {
  const state = binding.session.getSnapshot()
  if (!state.blank || state.running || state.removed || state.subagent !== null || state.openState !== 'open' || state.pendingSubmissions.length || state.awaitingFirstTurn) throw changed()
}

function assertPlain(input: Input): Draft {
  const value = input.state.getSnapshot()
  if (value.phase !== 'plain' || value.claim !== undefined || value.occurrences.length) throw new GitError('WORKTREE_RICH_DRAFT', '草稿包含指令或引用标签，当前宿主无法无损迁移。原草稿已保留，请先选择工作树再添加这些内容。')
  if (value.queue.length) throw changed()
  return value
}

function presetOf(services: Services, id: string): string | undefined {
  const catalog = services.sessions.list.getSnapshot()
  if (catalog.phase !== 'ready' || !catalog.byId[id]) throw changed()
  const value = catalog.byId[id].projectionValues?.agentPreset
  if (value !== undefined && (typeof value !== 'string' || !value || value.length > 256)) throw unsupported()
  return value as string | undefined
}

function until<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(changed()) }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(changed()); else resolve(value) }, () => { signal.removeEventListener('abort', abort); reject(new GitError('WORKTREE_PREPARATION_FAILED', '工作树会话准备失败，原会话和草稿已保留，请重试。')) })
    if (signal.aborted) abort()
  })
}

/** A capability-checked adapter over public 0.2.1-rc.2 APIs, without editing the Host or its input internals. */
export function createGitWorktreeNavigation(ctx: Context): GitWorktreeNavigation {
  const lifetime = new AbortController(), preparations = new Map<string, Prepared>(), operations = new Set<AbortController>()
  let disposed = false, busy = false, revision = 0
  const current = (prepared: Prepared, id: string, checkSelection = true) => {
    const { services } = prepared
    if (disposed || hostServiceIdentity(ctx.get('connection')) !== hostServiceIdentity(services.connection) || services.connection.generation.getSnapshot() !== prepared.connectionGeneration || checkSelection && services.current.getSnapshot()?.key !== id || services.sessions.binding(id) !== prepared.binding) throw changed()
    assertBlank(prepared.binding)
    const draft = assertPlain(prepared.input)
    if (draft.draftRev !== prepared.draft.draftRev || draft.draft !== prepared.draft.draft || !sameIds(draft.attachmentIds, prepared.draft.attachmentIds) || serial(prepared.binding.session.projections.faceOf('modelSelection').getSnapshot()) !== prepared.modelProjection || serial(prepared.binding.session.projections.faceOf('permissions').getSnapshot()) !== prepared.permissionProjection || presetOf(services, id) !== prepared.preset) throw changed()
    if (services.modelDirectories?.directoryFor(id).store.getSnapshot().pending) throw changed()
  }
  return {
    get available() { return !disposed && discover(ctx) !== undefined },
    async preflight(sessionId) {
      if (busy) throw new GitError('WORKTREE_BUSY', '已有工作树会话正在准备，请等待完成。')
      const services = discover(ctx), sequence = ++revision
      preparations.clear()
      if (!services || disposed) throw unsupported()
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(20_000)])
      operations.add(controller)
      let reference: Reference | undefined
      try {
        if (services.current.getSnapshot()?.key !== sessionId || services.connection.generation.getSnapshot() === undefined) throw changed()
        reference = services.sessions.retain(sessionId, { source: 'workspaceOperation', signal })
        const binding = await until(reference.ready, signal)
        assertBlank(binding)
        const input = services.conversation.input.for(binding.ctx)
        if (!functions(input, ['setDraft', 'addAttachments', 'removeAttachment']) || !functions(input.state, ['getSnapshot', 'subscribe'])) throw unsupported()
        const draft = assertPlain(input), modelProjection = serial(binding.session.projections.faceOf('modelSelection').getSnapshot()), permissionProjection = serial(binding.session.projections.faceOf('permissions').getSnapshot())
        if (services.conversation.blocks.storeFor(sessionId).getSnapshot() !== undefined) throw new GitError('WORKTREE_BUSY', '当前会话正在处理其他操作，请等待完成。')
        const prepared: Prepared = { services, binding, input, draft: { ...draft, attachmentIds: [...draft.attachmentIds], occurrences: [...draft.occurrences], queue: [...draft.queue] }, model: { provider: '', model: '' }, modelProjection, permissionProjection, permission: permissionOf(binding.session.projections.faceOf('permissions').getSnapshot()), preset: presetOf(services, sessionId), connectionGeneration: services.connection.generation.getSnapshot() }
        const descriptors = services.conversation.resolveDraftAttachments(draft.attachmentIds)
        if (!sameIds(descriptors.map(value => value.id), draft.attachmentIds)) throw new GitError('WORKTREE_ATTACHMENT_UNAVAILABLE', '草稿附件尚未就绪，请重新添加附件后再准备工作树。')
        current(prepared, sessionId)
        const projected = object(binding.session.projections.faceOf('modelSelection').getSnapshot())
        if (!('next' in projected)) throw unsupported()
        if (projected.next !== null && projected.next !== undefined) prepared.model = selection(projected.next)
        else {
          const catalog = await until(services.remote.session.modelCatalog(), signal)
          current(prepared, sessionId)
          if (!catalog.ok || !catalog.value) throw new GitError('WORKTREE_MODEL_UNAVAILABLE', '无法确认当前模型选择，请等待模型列表就绪后重试。')
          prepared.model = selection(catalog.value.default)
        }
        current(prepared, sessionId)
        if (sequence !== revision) throw changed()
        preparations.set(sessionId, prepared)
      } finally { reference?.release(); operations.delete(controller); controller.abort() }
    },
    async openWorktree(sessionId, receipt, ownership = {}) {
      const prepared = preparations.get(sessionId)
      if (!prepared || disposed || !discover(ctx)) throw new GitError('WORKTREE_PREFLIGHT_REQUIRED', '请重新选择工作树，先检查当前会话的迁移能力。')
      if (busy) throw new GitError('WORKTREE_BUSY', '已有工作树会话正在准备，请等待完成。')
      if (!receipt.completed || typeof receipt.worktreePath !== 'string' || !/^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(receipt.worktreePath) || receipt.worktreePath.includes('\0')) throw new GitError('WORKTREE_INVALID_RECEIPT', '工作树目录尚未确认，请刷新后重试。')
      current(prepared, sessionId)
      const { services } = prepared, sourceStore = services.conversation.blocks.storeFor(sessionId), existing = sourceStore.getSnapshot()
      if (existing !== undefined && existing !== ownership.sourceBlock || existing === undefined && ownership.sourceBlock !== undefined) throw new GitError('WORKTREE_BUSY', '当前会话正在处理其他操作，请等待完成。')
      const sourceBlock = existing ?? { reason: '正在准备独立工作树会话…' }, ownSourceBlock = existing === undefined
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(30_000)]), off: (() => void)[] = []
      operations.add(controller); busy = true
      let sourceReference: Reference | undefined, targetReference: Reference | undefined, target: Binding | undefined, targetInput: Input | undefined, targetBlock: Block | undefined, targetStore: Source<Block | undefined> | undefined
      let attached = false, initialized = false, rebound = false, opening = false, committed = false, originalCleared = false
      const guard = () => { signal.throwIfAborted(); if (!opening) current(prepared, sessionId); if (sourceStore.getSnapshot() !== sourceBlock) throw changed() }
      try {
        if (ownSourceBlock) services.conversation.blocks.set(sessionId, sourceBlock)
        off.push(services.current.subscribe(() => { const id = services.current.getSnapshot()?.key; if (!opening ? id !== sessionId : id !== undefined && id !== sessionId && id !== target?.sessionId) controller.abort() }))
        off.push(services.connection.generation.subscribe(() => { if (services.connection.generation.getSnapshot() !== prepared.connectionGeneration) controller.abort() }))
        const changedSource = () => { if (!committed) { try { current(prepared, sessionId, !opening) } catch { controller.abort() } } }
        off.push(prepared.input.state.subscribe(changedSource), prepared.binding.session.subscribe(changedSource), prepared.binding.session.projections.faceOf('modelSelection').subscribe(changedSource), prepared.binding.session.projections.faceOf('permissions').subscribe(changedSource), services.sessions.list.subscribe(changedSource))
        sourceReference = services.sessions.retain(sessionId, { source: 'workspaceOperation', signal }); await until(sourceReference.ready, signal); guard()
        const workspace = await until(services.workspaces.create({ path: receipt.worktreePath }), signal); guard()
        if (!workspace.workspaceId || pathKey(workspace.path) !== pathKey(receipt.worktreePath)) throw changed()
        if (services.workspaces.rename && receipt.snapshot?.repoName && receipt.branch) { await until(services.workspaces.rename(workspace.workspaceId, `${receipt.snapshot.repoName} · ${receipt.branch}`.slice(0, 160)), signal); guard() }
        const targetId = await until(services.sessions.create({ workspaceId: workspace.workspaceId, ...(prepared.preset ? { agentPreset: prepared.preset } : {}) }), signal); guard()
        if (targetId === sessionId) throw changed()
        targetReference = services.sessions.retain(targetId, { source: 'workspaceOperation', signal }); target = await until(targetReference.ready, signal); guard(); assertBlank(target)
        targetInput = services.conversation.input.for(target.ctx)
        const empty = assertPlain(targetInput)
        if (empty.draft || empty.attachmentIds.length || presetOf(services, targetId) !== prepared.preset) throw changed()
        targetStore = services.conversation.blocks.storeFor(targetId)
        if (targetStore.getSnapshot() !== undefined) throw new GitError('WORKTREE_BUSY', '目标会话正在处理其他操作，原草稿已保留。')
        targetBlock = { reason: '正在迁移当前会话的草稿与设置…' }; services.conversation.blocks.set(targetId, targetBlock)
        const selected = await until(services.remote.session.selectModel({ sessionId: targetId, ...prepared.model }), signal); guard(); assertBlank(target)
        if (!selected.ok || !selected.value || serial(selection(selected.value.selected)) !== serial(prepared.model)) throw new GitError('WORKTREE_MODEL_UNAVAILABLE', '目标会话无法保留当前模型和思考强度，原草稿已保留。')
        if (prepared.permission !== undefined) {
          const result = await until(target.session.command(`/permission ${prepared.permission}`), signal); guard(); assertBlank(target)
          if (!result.ok || result.value?.matched !== true) throw new GitError('WORKTREE_PERMISSION_UNAVAILABLE', '目标会话无法保留当前权限，原草稿已保留。')
        }
        await until(services.sessions.refreshProjections(targetId), signal); guard(); assertBlank(target)
        if (serial(selection(object(target.session.projections.faceOf('modelSelection').getSnapshot()).next)) !== serial(prepared.model) || permissionOf(target.session.projections.faceOf('permissions').getSnapshot()) !== prepared.permission || presetOf(services, targetId) !== prepared.preset) throw new GitError('WORKTREE_SETTINGS_CHANGED', '目标会话设置尚未确认，原草稿已保留。')
        if (targetStore.getSnapshot() !== targetBlock) throw changed()
        if (services.conversation.input.requestDraftInitialization(target, { prompt: prepared.draft.draft, clearPreviousDraft: false }) !== 'applied') throw changed()
        initialized = true
        if (!targetInput.addAttachments(prepared.draft.attachmentIds)) throw changed()
        attached = true
        if (prepared.draft.attachmentIds.length) { rebound = true; services.conversation.rebindDraftFiles(targetId, prepared.draft.attachmentIds) }
        guard()
        const readyDraft = targetInput.state.getSnapshot()
        if (readyDraft.draft !== prepared.draft.draft || !sameIds(readyDraft.attachmentIds, prepared.draft.attachmentIds)) throw changed()
        opening = true
        services.navigation.openSession(targetId)
        await until(new Promise<void>((resolve, reject) => {
          let stop = () => {}
          const check = () => { const selectedId = services.current.getSnapshot()?.key; if (selectedId === targetId) { stop(); resolve() } else if (selectedId !== undefined && selectedId !== sessionId) { stop(); reject(changed()) } }
          stop = services.current.subscribe(check); off.push(stop); check()
        }), signal)
        if (services.current.getSnapshot()?.key !== targetId || hostServiceIdentity(ctx.get('connection')) !== hostServiceIdentity(services.connection) || services.connection.generation.getSnapshot() !== prepared.connectionGeneration || sourceStore.getSnapshot() !== sourceBlock || targetStore.getSnapshot() !== targetBlock) throw changed()
        current(prepared, sessionId, false); assertBlank(target)
        const finalDraft = assertPlain(targetInput)
        if (finalDraft.draft !== prepared.draft.draft || !sameIds(finalDraft.attachmentIds, prepared.draft.attachmentIds) || serial(selection(object(target.session.projections.faceOf('modelSelection').getSnapshot()).next)) !== serial(prepared.model) || permissionOf(target.session.projections.faceOf('permissions').getSnapshot()) !== prepared.permission || presetOf(services, targetId) !== prepared.preset) throw changed()
        const original = assertPlain(prepared.input)
        if (original.draftRev !== prepared.draft.draftRev || original.draft !== prepared.draft.draft || !sameIds(original.attachmentIds, prepared.draft.attachmentIds)) throw changed()
        committed = true; originalCleared = true
        for (const id of prepared.draft.attachmentIds) if (!prepared.input.removeAttachment(id)) throw changed()
        prepared.input.setDraft('')
        if (prepared.input.state.getSnapshot().draft || prepared.input.state.getSnapshot().attachmentIds.length) throw changed()
      } catch (error) {
        let sourceRestored = true
        if (originalCleared) {
          try { prepared.input.setDraft(prepared.draft.draft); const missing = prepared.draft.attachmentIds.filter(id => !prepared.input.state.getSnapshot().attachmentIds.includes(id)); if (missing.length) prepared.input.addAttachments(missing); const restored = prepared.input.state.getSnapshot(); sourceRestored = restored.draft === prepared.draft.draft && sameIds(restored.attachmentIds, prepared.draft.attachmentIds) } catch { sourceRestored = false }
        }
        if (!sourceRestored) throw new GitError('WORKTREE_DRAFT_RECOVERY', '原会话草稿恢复尚未完成，完整草稿和附件已保留在工作树会话中，请打开该会话查看。')
        if (targetInput && attached) { try { for (const id of prepared.draft.attachmentIds) targetInput.removeAttachment(id) } catch { /* Never release shared attachment objects. */ } }
        if (rebound) { try { services.conversation.rebindDraftFiles(sessionId, prepared.draft.attachmentIds) } catch { /* Original descriptors remain available for retry. */ } }
        if (targetInput && initialized) { try { if (targetInput.state.getSnapshot().draft === prepared.draft.draft) targetInput.setDraft('') } catch { /* Preserve any target edits rather than clearing them. */ } }
        if (opening && !signal.aborted && services.current.getSnapshot()?.key === target?.sessionId) { try { services.navigation.openSession(sessionId) } catch { /* Original Session remains catalogued and retained until finally. */ } }
        if (error instanceof GitError) throw error
        throw changed()
      } finally {
        for (const unsubscribe of off.splice(0).reverse()) { try { unsubscribe() } catch { /* Other lifetime cleanup must still run. */ } }
        try { if (target && targetStore?.getSnapshot() === targetBlock) services.conversation.blocks.set(target.sessionId, undefined) } catch { /* The target scope may already have ended. */ }
        try { if (ownSourceBlock && sourceStore.getSnapshot() === sourceBlock) services.conversation.blocks.set(sessionId, undefined) } catch { /* Never replace another owner's block. */ }
        try { targetReference?.release() } finally { try { sourceReference?.release() } finally { operations.delete(controller); controller.abort(); preparations.delete(sessionId); busy = false } }
      }
    },
    dispose() { if (disposed) return; disposed = true; ++revision; lifetime.abort(); preparations.clear(); for (const operation of operations) operation.abort(); operations.clear() },
  }
}
