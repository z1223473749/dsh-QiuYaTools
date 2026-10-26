/** Prepare a quoted question in a fresh conversation without submitting it. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'

interface Model { provider: string; model: string; reasoningEffort?: string }
interface ModelRemote { session?: { selectModel?: (request: Model & { sessionId: SessionId }) => Promise<{ ok: boolean; error?: { message: string } }> } }
interface PreparedQuestion {
  readonly quote: string
  readonly requestedId: SessionId
  readonly prompt: string
  readonly options: Parameters<Context['sessions']['create']>[0]
  readonly model: Model | undefined
  targetId?: SessionId
  reference?: SessionReference
  modelApplied?: boolean
  initialized?: boolean
}

export interface NewConversationQuestion {
  open(quote: string): Promise<void>
  dispose(): void
}

function modelOf(value: unknown): Model | undefined {
  if (!value || typeof value !== 'object' || !('next' in value)) return
  const next = value.next
  if (!next || typeof next !== 'object' || !('provider' in next) || !('model' in next)
    || typeof next.provider !== 'string' || !next.provider || typeof next.model !== 'string' || !next.model) return
  const effort = 'reasoningEffort' in next ? next.reasoningEffort : undefined
  return { provider: next.provider, model: next.model, ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) }
}

/** Same-text retries reuse their created target; no source draft or attachment is moved. */
export function createNewConversationQuestion(ctx: Context, source: SessionBinding, locale: 'zh' | 'en' = 'zh'): NewConversationQuestion {
  const english = locale === 'en'
  const fail = (zh: string, en: string): Error => new Error(english ? en : zh)
  const changed = (): Error => fail('当前会话已变化，请重新选择文字。', 'The source conversation changed. Select the text again.')
  let disposed = false
  let prepared: PreparedQuestion | undefined
  let inFlight: { quote: string; promise: Promise<void> } | undefined

  const assertSource = (selection?: unknown): void => {
    const current = ctx.uiSession.adapter.current.getSnapshot()
    const state = source.session.getSnapshot()
    if (disposed || ctx.sessions.binding(source.sessionId) !== source || current.key !== source.sessionId
      || selection !== undefined && current !== selection || state.removed || state.subagent !== null || state.openState !== 'open') throw changed()
  }
  const release = (): void => { prepared?.reference?.release(); if (prepared) delete prepared.reference }
  const prepare = (quote: string): PreparedQuestion => {
    const workspaces = ctx.workspaces.list.getSnapshot()
    const catalog = ctx.sessions.list.getSnapshot()
    const summary = catalog.byId[source.sessionId]
    if (workspaces.phase !== 'ready' || catalog.phase !== 'ready' || !summary) throw fail('会话与工作区信息尚未就绪，请稍后重试。', 'Conversation and workspace information is not ready.')
    const owners = workspaces.items.filter(item => item.sessionIds.includes(source.sessionId))
    if (owners.length > 1) throw fail('无法确定当前会话的工作区，请刷新后重试。', 'The source workspace could not be determined.')
    const values = summary.projectionValues as Readonly<Record<string, unknown>> | undefined
    const preset = source.session.projections.faceOf('agentPreset').getSnapshot() ?? values?.agentPreset
    if (preset !== undefined && (typeof preset !== 'string' || !preset.trim())) throw changed()
    const requestedId = crypto.randomUUID() as SessionId
    const options = { sessionId: requestedId,
      ...(owners[0] ? { workspaceId: owners[0].workspaceId } : summary.cwd ? { cwd: summary.cwd } : {}),
      ...(typeof preset === 'string' ? { agentPreset: preset } : {}),
    }
    const prompt = [english ? 'Regarding this passage from another conversation:' : '针对另一会话中的这段内容：', '',
      ...quote.split('\n').map(line => `> ${line}`), '', english ? 'My question: ' : '我的问题：'].join('\n')
    return { quote, requestedId, options, prompt, model: modelOf(source.session.projections.faceOf('modelSelection').getSnapshot()) }
  }

  const perform = async (quote: string): Promise<void> => {
    assertSource()
    const selection = ctx.uiSession.adapter.current.getSnapshot()
    if (!prepared || prepared.quote !== quote) { release(); prepared = prepare(quote) }
    const question = prepared
    if (!question.targetId) {
      question.targetId = await ctx.sessions.create(question.options)
      if (question.targetId === source.sessionId) throw changed()
    }
    assertSource(selection)
    if (!question.reference) question.reference = ctx.sessions.retain(question.targetId, { source: 'controllerOperation' })
    let target: SessionBinding
    try { target = await question.reference.ready }
    catch (error) {
      // A failed initial acquisition owns no prepared draft. Reacquire this
      // same target on retry instead of reusing an already-rejected waiter.
      question.reference?.release()
      delete question.reference
      throw error
    }
    assertSource(selection)
    if (ctx.sessions.binding(question.targetId) !== target || target.sessionId !== question.targetId) throw changed()
    const assertTarget = (): void => {
      const targetState = target.session.getSnapshot()
      if (ctx.sessions.binding(question.targetId!) !== target || targetState.removed || targetState.subagent !== null || targetState.openState !== 'open'
        || targetState.running || targetState.pendingSubmissions.length || targetState.awaitingFirstTurn || !targetState.blank) throw changed()
    }
    assertTarget()
    const input = ctx.conversation.input.for(target.ctx)
    if (!question.initialized) {
      const draft = input.state.getSnapshot()
      if (draft.phase !== 'plain' || draft.draft || draft.attachmentIds.length || draft.occurrences.length) throw fail('新会话已有草稿，已保留原内容，请重新选择文字。', 'The new conversation already has a draft. Its content was preserved.')
      const remote = ctx.get('remote') as unknown as ModelRemote | undefined
      if (!question.modelApplied && question.model && typeof remote?.session?.selectModel === 'function') {
        const result = await remote.session.selectModel({ sessionId: question.targetId, ...question.model })
        assertSource(selection)
        if (!result.ok) throw fail('新会话暂时无法沿用当前模型，请重试。', 'The current model could not be selected for the new conversation.')
        question.modelApplied = true
      }
      assertSource(selection)
      assertTarget()
      if (ctx.conversation.input.requestDraftInitialization(target, { prompt: question.prompt, clearPreviousDraft: false }) !== 'applied') {
        throw fail('新会话的输入状态已变化，已有草稿已保留。', 'The new conversation input changed. Its existing draft was preserved.')
      }
      question.initialized = true
    }
    assertSource(selection)
    ctx.uiWorkspace.openSession(question.targetId)
    // Navigation owns the main-view retain before this preparation releases it.
    release()
    prepared = undefined
  }

  return {
    open(quote) {
      if (!quote.trim()) return Promise.reject(fail('请先选择需要提问的文字。', 'Select text before asking in a new conversation.'))
      if (inFlight) return inFlight.quote === quote ? inFlight.promise : Promise.reject(fail('正在打开新会话，请稍候。', 'A new conversation is already opening.'))
      const promise = perform(quote).finally(() => { if (inFlight?.promise === promise) inFlight = undefined })
      inFlight = { quote, promise }
      return promise
    },
    dispose() { disposed = true; release() },
  }
}
