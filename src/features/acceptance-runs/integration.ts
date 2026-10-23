import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RootAgentRegistry, RunAttachmentStore, RunProfile, RunSessionQuery } from './sdk-host-seams.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import type { ComputerToolsRecorder } from '../computer-use/tools.ts'
import { canonicalJSON, RunError, TERMINAL_STATES } from './contract.ts'
import type { AgentBinding, EvidenceRef, RunView } from './contract.ts'
import { AcceptanceRunService } from './service.ts'
import type { MutationResult, RunAuthority, RunExec, RunHistoryReader, RunReadScope } from './service.ts'
import { AcceptanceRunStore } from './storage.ts'
import { installAcceptanceRunHost } from './host.ts'
import { installAcceptanceRunTools } from './tools.ts'

export interface ComputerRunDependencies {
  agents: RootAgentRegistry
  attachments: RunAttachmentStore
  manager: Pick<ComputerEnvironmentManager, 'runEnvironment'>
  profileDirectory: string
  enabled(): boolean
  version: string
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const geometryDigest = (geometry: EvidenceRef['geometry']) => sha(Buffer.from(canonicalJSON(geometry)))
const sameBinding = (a: AgentBinding, b: AgentBinding) => canonicalJSON(a) === canonicalJSON(b)
const fresh = () => 'host:' + randomUUID()
const mutation = (record: { runId: string; revision: number }) => ({ runId: record.runId, expectedRevision: record.revision, idempotencyKey: fresh() })
async function bounded<T>(signal: AbortSignal, read: (child: AbortSignal) => Promise<T>): Promise<T> {
  const child = AbortSignal.any([signal, AbortSignal.timeout(2000)])
  child.throwIfAborted()
  let aborted = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(new RunError('READ_CANCELLED'))
    child.addEventListener('abort', aborted, { once: true })
  })
  try { return await Promise.race([read(child), cancelled]) }
  finally { child.removeEventListener('abort', aborted) }
}
function attachmentReference(ref: Readonly<Pick<EvidenceRef, 'attachmentId' | 'mediaType' | 'bytes' | 'width' | 'height'>>): ImageAttachmentRef {
  return { attachmentId: AttachmentId(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
}

/** Trusted bridge. Production passes actual public SDK services; no model can supply authority or a verifier. */
export function createComputerRunBridge(deps: ComputerRunDependencies) {
  const interruptedRuns = new Set<string>()
  const lifetime = new AbortController(), instances = new WeakMap<object, string>(), runs = new WeakMap<object, Set<string>>()
  const live = () => { if (lifetime.signal.aborted || !deps.enabled()) throw new RunError('CALLER_NOT_LIVE') }
  const binding = (handle: object, id: string): AgentBinding => {
    live()
    const actual = deps.agents.get(SessionId(id))
    if (!actual || actual !== handle || !deps.agents.roots().includes(actual)) throw new RunError('CALLER_NOT_LIVE')
    const environment = deps.manager.runEnvironment(id)
    if (!environment) throw new RunError('OWNER_CHANGED')
    let instanceId = instances.get(handle)
    if (!instanceId) { instanceId = randomUUID(); instances.set(handle, instanceId) }
    return { chatSessionId: id, agentId: id, rootAgentId: id, agentInstanceId: instanceId,
      environmentId: environment.environmentId, epoch: environment.epoch, targetIds: [environment.target.id] }
  }
  const authority: RunAuthority = {
    resolve(exec) { exec.signal.throwIfAborted(); if (!exec.agent) throw new RunError('CALLER_NOT_LIVE'); return { ...binding(exec.agent, exec.agent.id), agentHandle: exec.agent } },
    current(expected, handle) { try { return sameBinding(expected, binding(handle, expected.agentId)) } catch { return false } },
  }
  const readImage = async (ref: Readonly<EvidenceRef>, signal: AbortSignal) => {
    const data = await bounded(AbortSignal.any([signal, lifetime.signal]), child => deps.attachments.readImage(attachmentReference(ref), child))
    signal.throwIfAborted(); live()
    // readImage attests the normalized stored reference; never hash the raw pre-normalized screenshot instead.
    if (data.ref.attachmentId !== ref.attachmentId || data.ref.mediaType !== ref.mediaType || data.ref.bytes !== ref.bytes || data.ref.width !== ref.width || data.ref.height !== ref.height || data.data.byteLength !== ref.bytes || sha(data.data) !== ref.sha256) throw new RunError('EVIDENCE_UNAVAILABLE')
    return data.data
  }
  const core = AcceptanceRunService.create({ store: new AcceptanceRunStore({ profileDirectory: deps.profileDirectory }), authority,
    evidence: { async inspect(ref, signal) { const bytes = await readImage(ref, signal); return { attachmentId: ref.attachmentId, sha256: sha(bytes), mediaType: ref.mediaType, bytes: bytes.byteLength, width: ref.width, height: ref.height } } },
    // Helper/model identities are not exposed by the public observation seam. Do not fabricate version receipts.
    versions: { plugin: deps.version, runtime: process.version, helper: 'not-recorded', protocol: 'qiuya-computer/1', model: 'not-recorded' },
  })
  const interrupt = (runId: string) => { interruptedRuns.add(runId); core.recorder.interrupt(runId) }
  const active = async (exec: RunExec): Promise<RunView | undefined> => {
    if (!exec.agent || !runs.has(exec.agent)) return undefined
    const current = binding(exec.agent, exec.agent.id)
    const views: RunView[] = []
    for (const id of runs.get(exec.agent)!) {
      const view = await core.service.get(exec, id)
      if (!authority.current(current, exec.agent) || exec.signal.aborted) throw new RunError('CALLER_NOT_LIVE')
      if (!TERMINAL_STATES.includes(view.record.state) && interruptedRuns.has(id)) throw new RunError('HISTORY_READ_ONLY')
      if (!view.readOnly && !TERMINAL_STATES.includes(view.state)) views.push(view)
    }
    if (views.length > 1) throw new RunError('RUN_AMBIGUOUS')
    return views[0]
  }
  const onBegin = async (exec: RunExec, result: MutationResult) => {
    live()
    if (!exec.agent || result.readOnly || result.record.state !== 'queued') throw new RunError('CALLER_NOT_LIVE')
    const started = await core.recorder.setState(exec, { ...mutation(result.record), state: 'running' })
    const ids = runs.get(exec.agent) ?? new Set<string>()
    // Only an explicit same-chat previousRunId may replace this Host's interrupted live record.
    if (started.record.previousRunId && interruptedRuns.has(started.record.previousRunId)) ids.delete(started.record.previousRunId)
    ids.add(started.record.runId); runs.set(exec.agent, ids)
    return started
  }
  const computer: ComputerToolsRecorder = {
    async observed(exec, observation, image, capturedAt) {
      const view = await active(exec)
      if (!view) return undefined
      const attempts = view.record.attempts.filter(attempt => attempt.verdict === null)
      if (attempts.length !== 1) throw new RunError('ATTEMPT_AMBIGUOUS')
      const attempt = attempts[0]!, expected = view.record.binding
      const currentObservation = () => deps.manager.runEnvironment(expected.chatSessionId)?.observation
      const sameFrame = () => { const actual = currentObservation(); return !!actual && actual.frameId === observation.frameId && actual.targetId === observation.targetId && geometryDigest(actual.geometry) === geometryDigest(observation.geometry) }
      if (observation.targetId !== expected.targetIds[0] || !authority.current(expected, exec.agent!) || !sameFrame()) throw new RunError('OWNER_CHANGED')
      if (!['image/jpeg', 'image/png'].includes(image.mediaType)) throw new RunError('EVIDENCE_UNAVAILABLE')
      const mediaType = image.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      const stored = await bounded(AbortSignal.any([exec.signal, lifetime.signal]), signal => deps.attachments.readImage({ ...image, attachmentId: AttachmentId(image.attachmentId), mediaType }, signal))
      if (!authority.current(expected, exec.agent!) || exec.signal.aborted || !sameFrame()) throw new RunError('CALLER_NOT_LIVE')
      if (stored.ref.attachmentId !== image.attachmentId || stored.ref.mediaType !== image.mediaType || stored.ref.bytes !== image.bytes || stored.ref.width !== image.width || stored.ref.height !== image.height || stored.data.byteLength !== image.bytes) throw new RunError('EVIDENCE_UNAVAILABLE')
      const evidence: EvidenceRef = { evidenceId: randomUUID(), runId: view.record.runId, checkId: attempt.checkId, attemptId: attempt.attemptId,
        environmentId: expected.environmentId, targetId: observation.targetId, frameId: observation.frameId, epoch: expected.epoch,
        geometry: { ...observation.geometry }, geometryDigest: geometryDigest(observation.geometry), capturedAt, source: 'computer-observe',
        sha256: sha(stored.data), mediaType, bytes: image.bytes, width: image.width, height: image.height, attachmentId: image.attachmentId, commitState: 'committed' }
      const result = await core.recorder.commitEvidence(exec, { ...mutation(view.record), evidence })
      return { runId: result.record.runId, revision: result.record.revision, checkId: attempt.checkId, attemptId: attempt.attemptId, evidenceId: evidence.evidenceId }
    },
    async issuing(exec, request) {
      const view = await active(exec)
      if (!view) return undefined
      const attempts = view.record.attempts.filter(attempt => attempt.verdict === null)
      if (attempts.length !== 1) throw new RunError('ATTEMPT_AMBIGUOUS')
      if (!view.record.evidence.some(e => e.frameId === request.frameId && e.attemptId === attempts[0]!.attemptId && e.epoch === view.record.binding.epoch && e.targetId === view.record.binding.targetIds[0])) throw new RunError('MISSING_EVIDENCE')
      // The input payload, Unicode, keys, selectors and URLs never enter a receipt.
      const base = { callId: exec.callId, rootCallId: exec.rootCallId ?? null, actionId: request.actionId, kind: request.action.kind,
        targetId: view.record.binding.targetIds[0]!, frameId: request.frameId, environmentId: view.record.binding.environmentId, epoch: view.record.binding.epoch }
      let issued: MutationResult
      try { issued = await core.recorder.recordAction(exec, { ...mutation(view.record), receipt: { ...base, receiptId: randomUUID(), phase: 'issued', at: Date.now(), errorCode: null } }) }
      catch (error) { interrupt(view.record.runId); throw error }
      let consumed = false
      return async result => {
        if (consumed) throw new RunError('ACTION_REPLAY_FORBIDDEN')
        consumed = true
        // Never fabricate a fresh exec/signal after cancellation. Unacknowledged issued remains inconclusive.
        if (!authority.current(issued.record.binding, exec.agent!) || exec.signal.aborted) { interrupt(issued.record.runId); throw new RunError('CALLER_NOT_LIVE') }
        const acknowledged = !!result && result.actionId === base.actionId && result.targetId === base.targetId && result.epoch === base.epoch
        let committed: MutationResult
        try { committed = await core.recorder.recordAction(exec, { ...mutation(issued.record), receipt: { ...base, receiptId: randomUUID(), phase: acknowledged ? 'acknowledged' : 'unknown', at: Date.now(), errorCode: acknowledged ? null : 'ACTION_UNCONFIRMED' } }) }
        catch (error) { interrupt(issued.record.runId); throw error }
        return { runId: committed.record.runId, revision: committed.record.revision, phase: acknowledged ? 'acknowledged' : 'unknown' }
      }
    },
  }
  const project = (view: RunView): RunView => {
    const agent = deps.agents.get(SessionId(view.record.binding.agentId))
    const interrupted = !TERMINAL_STATES.includes(view.record.state) && (interruptedRuns.has(view.record.runId) || !agent || !authority.current(view.record.binding, agent))
    return interrupted ? { ...view, state: 'inconclusive', readOnly: true, recovery: 'historical' } : view
  }
  const reader: RunHistoryReader = {
    async get(scope, id) { const view = await core.reader.get(scope, id); scope.assertCurrent(); return project(view) },
    async list(scope) { const rows = await core.reader.list(scope); scope.assertCurrent(); const out: typeof rows = []
      for (const row of rows) { const view = await reader.get(scope, row.runId); scope.assertCurrent(); out.push({ ...row, state: view.state }) } return out },
    async export(scope, id) { const view = await reader.get(scope, id); scope.assertCurrent(); const value = await core.reader.export(scope, id); scope.assertCurrent()
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunError('RUN_UNAVAILABLE')
      if (!('revision' in value) || value.revision !== view.record.revision) throw new RunError('REVISION_CONFLICT')
      const latest = project(view)
      // Preserve the core's newer evidence-unavailable projection. Override only lifecycle drift.
      return !TERMINAL_STATES.includes(view.record.state) && latest.recovery === 'historical'
        ? { ...value, state: latest.state, recovery: latest.recovery, readOnly: true, replayPermitted: false } : value },
    evidence: (scope, runId, evidenceId) => core.reader.evidence(scope, runId, evidenceId),
  }
  return { service: core.service, computer, onBegin, reader, readImage,
    dispose() { lifetime.abort(new RunError('CALLER_NOT_LIVE')) } }
}

/** Actual owner/profile services only. No personal model configuration or extra Agent is created. */
export function installComputerAcceptanceRuns(ctx: Context, manager: ComputerEnvironmentManager, options: { enabled(): boolean; version: string }) {
  const profile = ctx.get('profileContext') as RunProfile | undefined
  const agents = ctx.get('agents') as RootAgentRegistry | undefined
  const attachments = ctx.get('attachments') as RunAttachmentStore | undefined
  const query = ctx.get('sessionQuery') as RunSessionQuery | undefined
  const connection = ctx.get('connection') as { browserPeer?: { principal: { kind: string } } } | undefined
  if (!profile?.dir || !agents || !attachments || !query || !connection) throw new RunError('RUN_SERVICES_UNAVAILABLE')
  const lifetime = new AbortController()
  const bridge = createComputerRunBridge({ agents, attachments, manager, profileDirectory: profile.dir, enabled: () => !lifetime.signal.aborted && options.enabled(), version: options.version })
  const resolveScope = async (chatSessionId: string, signal: AbortSignal): Promise<RunReadScope> => {
    const peer = connection.browserPeer, principal = peer?.principal
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (lifetime.signal.aborted || !options.enabled() || ctx.get('connection') !== connection || connection.browserPeer !== peer || peer?.principal !== principal || principal?.kind !== 'owner') throw new RunError('OWNER_CHANGED')
    }
    assertCurrent()
    const observation = await bounded(AbortSignal.any([signal, lifetime.signal]), child => query.observeSession(SessionId(chatSessionId), { signal: child, projectionMode: 'none' }).then(observation => { if (child.aborted) { observation[Symbol.dispose](); throw new RunError('READ_CANCELLED') } return observation }))
    try { assertCurrent(); if (observation.header.id !== chatSessionId) throw new RunError('RUN_NOT_FOUND') }
    finally { observation[Symbol.dispose]() }
    assertCurrent()
    return { chatSessionId, signal, assertCurrent }
  }
  const unregisterTools = installAcceptanceRunTools(ctx, bridge.service, { enabled: options.enabled, onBegin: bridge.onBegin })
  let unregisterHost: () => Promise<void>
  try { unregisterHost = installAcceptanceRunHost(ctx, bridge.reader, { resolveScope, readEvidence: bridge.readImage }) }
  catch (error) { unregisterTools(); bridge.dispose(); throw error }
  return { computer: bridge.computer, async dispose() { lifetime.abort(); bridge.dispose(); unregisterTools(); await unregisterHost() } }
}
