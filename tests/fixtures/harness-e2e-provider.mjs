/** Local-only deterministic provider for the installed Harness UI E2E runner. */
import { appendFileSync, readFileSync, realpathSync, writeFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import {createHash} from 'node:crypto'
import {threadId} from 'node:worker_threads'
import {OwnedMacInputSourceTrace} from './harness-passive-input-source.mjs'
import {installOwnedPreviewRPCTrace} from './owned-preview-rpc-trace.mjs'
import { readOwnedHarnessFeatureEvidence } from '../../scripts/harness-feature-evidence.mjs'
export const name = 'qiuya-harness-e2e-provider'
export const inject = ['llm', 'agents', 'connection', 'workspaceRegistry', 'sessionQuery']
const provider = 'qiuya-e2e'
const model = 'fixture'
const plan = '# E2E 测试计划\n\n检查真实会话和插件菜单。\n\n验证批注会提交为新的提示，不覆盖原有草稿。'
const metadata = { provider, id: model, name: 'QiuYa 本地测试模型', inputModalities: ['text', 'image'], context: { contextWindow: 128000 }, defaultMaxTokens: 4096, systemPromptUpdate: 'in-history' }
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
export const HARNESS_COMPUTER_DIAGNOSTIC_CODES = Object.freeze(['UNKNOWN_ERROR_CODE', 'COMPUTER_ENTRY_FAILED', 'SESSION_REQUIRED', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER', 'OWNER_RESUME_REQUIRED', 'OWNER_SWITCH_REQUIRED', 'REQUEST_CANCELLED', 'REQUEST_EXPIRED', 'REQUEST_STALE', 'CANDIDATE_EXPIRED', 'CALL_REPLAY_MISMATCH', 'REQUEST_LIMIT', 'REQUEST_PENDING', 'APPROVAL_DISABLED', 'APP_DENIED', 'DISCOVERY_UNAVAILABLE', 'SYSTEM_PERMISSION_REQUIRED', 'APPLICATION_WINDOW_REQUIRED', 'APPLICATION_UNAVAILABLE', 'APPLICATION_LAUNCH_UNSUPPORTED', 'APPLICATION_LAUNCH_UNCONFIRMED', 'SESSION_LIMIT', 'ENVIRONMENT_RETIRING', 'INVALID_REQUEST', 'SNAPSHOT_UNAVAILABLE', 'RPC_STATUS_FAILED', 'SESSION_MISMATCH', 'ACCESSIBILITY_REQUIRED', 'SCREEN_RECORDING_REQUIRED', 'CAPTURE_BUSY', 'CAPTURE_CHANGED', 'CAPTURE_START_FAILED', 'CAPTURE_STOPPED', 'CAPTURE_TIMEOUT', 'DESKTOP_BUSY', 'DESKTOP_LEASE_REQUIRED', 'DESKTOP_LOCK_FAILED', 'EVENT_FAILED', 'FOCUS_CHANGED', 'HUMAN_INPUT_INTERRUPTED', 'CURSOR_CLEANUP_FAILED', 'GEOMETRY_CHANGED', 'INPUT_BUSY', 'INPUT_CLEANUP_FAILED', 'INPUT_JOURNAL_FAILED', 'INPUT_JOURNAL_INVALID', 'INVALID_ACTION', 'INVALID_ACTOR', 'INVALID_COORDINATES', 'INVALID_EPOCH', 'INVALID_KEY', 'INVALID_TARGET', 'NATIVE_FAILURE', 'OBSERVATION_REQUIRED', 'PREVIEW_OVERLAP', 'STALE_EPOCH', 'TARGETS_UNAVAILABLE', 'TARGET_GONE', 'CONTROL_CHANGED', 'DISABLED', 'DISPOSED', 'SESSION_NOT_STARTED', 'NATIVE_LEASE_UNRELEASED', 'APP_NOT_ALLOWED', 'DEVICE_BUSY', 'NOT_READY', 'TARGET_NOT_FOUND', 'TARGET_CHANGED', 'STALE_OBSERVATION', 'OUT_OF_BOUNDS', 'ACTION_ID_CONFLICT', 'QUEUE_FULL', 'NATIVE_CLEANUP_FAILED', 'NATIVE_PIPE_FAILED', 'NATIVE_UNAVAILABLE', 'NATIVE_EXITED', 'NATIVE_TIMEOUT', 'NATIVE_PROTOCOL', 'NATIVE_PROTOCOL_VERSION', 'ABORTED', 'CODE_RUN_FAILED', 'TOOL_OUTPUT_INVALID', 'UNKNOWN_TOOL', 'invalid-target', 'target-unavailable', 'target-changed', 'capture-busy', 'geometry-changed', 'capture-unavailable', 'capture-timeout', 'invalid-epoch', 'input-cleanup-failed', 'human-monitor-unavailable', 'human-input-pending', 'stale-epoch', 'invalid-actor', 'foreground-changed', 'input-denied', 'input-busy', 'observation-required', 'foreground-denied'])
/** Only failed computer-tool receipts in this model request. Text, keys,
 * URLs, replay state and arbitrary exception fields are never persisted. */
export function projectHarnessComputerToolErrors(messages) {
  const calls = new Map(), result = []
  for (const message of messages.slice(-128)) if (message.role === 'assistant') for (const block of message.content ?? []) if (block.type === 'tool-call' && ['run_code', 'qiuya_computer_discover', 'qiuya_computer_request_control', 'qiuya_computer_observe', 'qiuya_computer_act', 'qiuya_computer_pause', 'qiuya_computer_status'].includes(block.name)) calls.set(block.id, block.name)
  for (const message of messages.slice(-128)) {
    const tool = calls.get(message.toolCallId ?? message.source?.callId)
    if (message.role !== 'tool' || message.isError !== true || !tool) continue
    const codes = new Set()
    function collect(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 4) return
      if (HARNESS_COMPUTER_DIAGNOSTIC_CODES.includes(value.code)) codes.add(value.code)
      for (const nested of Object.values(value)) collect(nested, depth + 1)
    }
    collect(message.error)
    for (const block of message.content ?? []) if (block.type === 'text') {
      try { collect(JSON.parse(block.text)) } catch {}
      // Some SDK versions expose only Error:<message>. Keep known standalone
      // code tokens if present, never the original rendered text.
      const tokens = new Set(block.text.split(/[^A-Za-z0-9_-]+/u))
      for (const code of HARNESS_COMPUTER_DIAGNOSTIC_CODES) if (tokens.has(code)) codes.add(code)
    }
    for (const code of codes.size ? codes : ['UNKNOWN_ERROR_CODE']) if (!result.some(row => row.tool === tool && row.code === code) && result.length < 16) result.push({ tool, code })
  }
  return result
}
/** Self-contained Playwright callback: retain exactly the selected fixture
 * session and public native input readback, before test teardown changes it. */
export async function captureHarnessComputerDiagnostic({ sessionId, codes }) {
  const code = value => codes.includes(value) ? value : 'UNKNOWN_ERROR_CODE'
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const bool = value => typeof value === 'boolean' ? value : null
  const id = value => typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9_.:-]+$/u.test(value) ? value : null
  const geometry = value => value ? Object.fromEntries(['x', 'y', 'width', 'height', 'scale'].map(key => [key, number(value[key])])) : null
  try {
    const response = await fetch('/api/qiuya-tools.computer.control', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'qiuya-tools.computer.control', payload: { op: 'status', sessionId } }) })
    const envelope = await response.json(), result = envelope.result
    if (!response.ok || !result?.ok) return { status: 'unavailable', code: code(result?.error?.code), phase: 'owned-status-rpc' }
    const session = result.value.sessions.find(row => row.sessionId === sessionId), native = result.value.native ?? {}
    if (!session || session.sessionId !== sessionId) return { status: 'unavailable', code: 'SESSION_MISMATCH' }
    const last = session.lastAction, observation = session.lastObservation, target = session.target
    return { status: 'captured', capturedAt: new Date().toISOString(),
      session: { sessionId, state: ['idle', 'connecting', 'awaitingPermission', 'ready', 'running', 'pausing', 'paused', 'handingOver', 'humanControl', 'resuming', 'stopping', 'stopped', 'disconnected', 'faulted'].includes(session.state) ? session.state : 'unknown', epoch: integer(session.epoch), updatedAt: number(session.updatedAt), error: session.error ? { code: code(session.error.code) } : null,
        target: target ? { id: id(target.id), appId: id(target.appId), pid: integer(target.pid), geometry: geometry(target) } : null,
        lastAction: last ? { actionId: id(last.actionId), actor: ['ai', 'human'].includes(last.actor) ? last.actor : null, phase: ['executing', 'completed', 'failed'].includes(last.phase) ? last.phase : null, at: number(last.at), action: { kind: ['click', 'move', 'drag', 'scroll', 'type', 'key'].includes(last.action?.kind) ? last.action.kind : 'other', ...Object.fromEntries(['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY'].filter(key => last.action?.[key] !== undefined).map(key => [key, number(last.action[key])])) } } : null,
        lastObservation: observation ? { targetId: id(observation.targetId), frameId: id(observation.frameId), width: integer(observation.width), height: integer(observation.height), geometry: geometry(observation.geometry) } : null },
      native: { available: bool(native.available), platform: ['darwin', 'win32'].includes(native.platform) ? native.platform : null, mode: ['local', 'remote', 'browser'].includes(native.mode) ? native.mode : null,
        permissions: Object.fromEntries(['screen', 'screenRecording', 'accessibility', 'postEvents', 'inputMonitoring'].map(key => [key, bool(native.permissions?.[key])])),
        focusAttempt: native.focusAttempt ? { ...Object.fromEntries(['targetPid', 'beforePid', 'afterPid', 'settledMs', 'axSettableResult', 'axFrontmostResult', 'raiseResult'].map(key => [key, integer(native.focusAttempt[key])])), activationAccepted: bool(native.focusAttempt.activationAccepted), inputPosted: bool(native.focusAttempt.inputPosted),
          inputRoute: ['metadata', 'pointer', 'keyboard'].includes(native.focusAttempt.inputRoute) ? native.focusAttempt.inputRoute : null,
          inputRouteStage: ['not-requested', 'metadata', 'pointer-route', 'keyboard-root', 'metadata-recheck', 'checked', 'deadline'].includes(native.focusAttempt.inputRouteStage) ? native.focusAttempt.inputRouteStage : null,
          keyboardFocusStage: ['not-requested', 'focused-window', 'owner', 'geometry', 'role', 'root-recheck', 'checked', 'deadline'].includes(native.focusAttempt.keyboardFocusStage) ? native.focusAttempt.keyboardFocusStage : null,
          ...Object.fromEntries(['metadataSamples', 'readinessSamples', 'consecutiveReadinessSamples', 'inputRouteChecks', 'inputRouteMs', 'keyboardFocusSamples'].map(key => [key, integer(native.focusAttempt[key])])),
          keyboardAXError: Number.isInteger(native.focusAttempt.keyboardAXError) && Math.abs(native.focusAttempt.keyboardAXError) <= 0x7fffffff ? native.focusAttempt.keyboardAXError : null,
          inputRouteAccepted: bool(native.focusAttempt.inputRouteAccepted), keyboardFocusAccepted: bool(native.focusAttempt.keyboardFocusAccepted) } : null,
        leaseReported: Object.hasOwn(native, 'leaseEpoch'), leaseEpoch: integer(native.leaseEpoch), leaseActor: ['ai', 'human'].includes(native.leaseActor) ? native.leaseActor : null,
        inputState: { reported: native.inputState !== undefined, mouseHeld: bool(native.inputState?.mouseHeld), keysHeld: integer(native.inputState?.keysHeld), leftButtonDown: bool(native.inputState?.leftButtonDown) } } }
  } catch { return { status: 'unavailable', code: 'SNAPSHOT_UNAVAILABLE' } }
}
const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, milliseconds)
  function done() { signal?.removeEventListener('abort', abort); resolve() }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')) }
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
})
/** Test-only same actual provider realm; NODE_OPTIONS alone is not proof of Host hook installation. */
export function installProviderOwnedPreviewTrace(ctx) {
  if(process.platform!=='darwin'||process.env.QIUYA_OWNED_PREVIEW_TRACE!=='1')return
  if(process.env.QIUYA_HARNESS_E2E!=='1')throw Error('TRACE_E2E_SCOPE_REQUIRED')
  const profileRoot=realpathSync(process.env.DSH_HOME)
  ctx.effect(()=>{
    const trace=installOwnedPreviewRPCTrace({profileRoot})
    const receipt={version:1,pid:process.pid,threadId,profileSHA256:createHash('sha256').update(profileRoot).digest('hex'),inputEventsPosted:0,networkRequests:0}
    writeFileSync(join(profileRoot,'owned-preview-rpc-installed.json'),JSON.stringify(receipt)+'\n',{flag:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode:0o600})
    return ()=>trace.stop()
  })
}
export function apply(ctx) {
  if (process.env.QIUYA_HARNESS_E2E !== '1' || !process.env.DSH_HOME?.includes('qiuya-harness-')) throw new Error('The E2E provider requires a dedicated temporary DSH_HOME')
  installProviderOwnedPreviewTrace(ctx)
  const passiveInputSource=process.platform==='darwin'&&process.env.QIUYA_PASSIVE_INPUT_SOURCE==='1'?new OwnedMacInputSourceTrace(process.env.DSH_HOME):null
  ctx.effect(()=>()=>passiveInputSource?.close())
  // Test-only, owner-only finite readback. The exact Session is bound by the
  // runner before its synthetic computer prompt; no other Agent is readable.
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/qiuya-e2e-owned-agent', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    if (ctx.connection.browserPeer?.principal?.kind !== 'owner') return new Response('Forbidden', { status: 403 })
    try {
      const { sessionId } = await request.json(), target = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'e2e-computer-target.json'), 'utf8'))
      if (!sessionId || sessionId !== target.sessionId) return new Response('Forbidden', { status: 403 })
      const agent = ctx.agents.get(sessionId)
      if (!agent) return Response.json({ sessionId, available: false })
      return Response.json({ sessionId, available: true, state: agent.status, nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length })
    } catch { return new Response('Invalid own fixture request', { status: 400 }) }
  } }))
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/qiuya-e2e-owned-feature', methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    if (ctx.connection.browserPeer?.principal?.kind !== 'owner') return new Response('Forbidden', { status: 403 })
    try {
      const binding = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'e2e-feature-target.json'), 'utf8'))
      return Response.json(await readOwnedHarnessFeatureEvidence(ctx, binding, await request.json()))
    } catch { return new Response('Invalid own feature request', { status: 400 }) }
  } }))
  const submittedPlans = new Set(), submittedComputers = new Map()
  function *call(name, args) {
    yield { type: 'tool-call-delta', index: 0, id: `fixture-call-${Date.now()}`, name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const adapter = {
    providerInfo: () => ({ id: provider, name: 'QiuYa 本地测试', nativeAuth: { env: [], oauth: false } }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [metadata],
    resolveModel: async () => metadata,
    prepareCall: async () => ({ model: metadata, stream: options => adapter.stream(options) }),
    async *stream(options) {
      const messages = options.messages ?? []
      const users = messages.filter(message => message.role === 'user')
      const latest = [...users].reverse().find(message => textOf(message).startsWith('E2E:')) ?? users.at(-1)
      const text = textOf(latest)
      const system = [options.system ?? '', ...messages.filter(message => message.role === 'system').map(textOf)].join('\n')
      const images = messages.flatMap((message, messageIndex) => (message.content ?? []).filter(block => block.type === 'image').map(block => ({
        messageIndex, role: message.role, attachmentId: block.attachment?.attachmentId, width: block.attachment?.width,
        height: block.attachment?.height, mediaType: block.attachment?.mediaType,
      })))
      const actionResults = []
      const toolErrors = text.startsWith('E2E:computer') ? projectHarnessComputerToolErrors(messages) : []
      function collectActions(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 4) return
        if (value.actionId === 'fixture-agent-move') actionResults.push({ actionId: value.actionId, targetId: value.targetId, epoch: value.epoch, performed: value.result?.performed === true })
        for (const nested of Object.values(value)) collectActions(nested, depth + 1)
      }
      for (const message of messages.filter(message => message.role === 'tool')) {
        for (const block of message.content ?? []) if (block.type === 'text') { try { collectActions(JSON.parse(block.text)) } catch {} }
      }
      appendFileSync(join(process.env.DSH_HOME, 'e2e-adapter-requests.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        sessionId: options.sessionId ?? null, marker: text.startsWith('E2E:') ? text.slice(0, 80) : 'auxiliary', tools: (options.tools ?? []).map(tool => tool.name),
        imageBlocks: images, actionResults, ...(text.startsWith('E2E:computer') ? { toolErrors } : {}), purpose: options.purpose ?? null }) + '\n', { mode: 0o600 })
      const key = `${options.sessionId}:${text}`
      if (options.maxTokens <= 200 && /natural sentence|next|建议|recommend/i.test(system)) {
        yield { type: 'text-delta', index: 0, text: '继续检查本地测试结果。' }
      } else if (text.startsWith('E2E:computer')) {
        const stage = submittedComputers.get(key) ?? 0
        const tools = options.tools ?? []
        // The runner owns this synthetic target. It supplies only its fixture
        // identity; all authority still comes from discover -> owner card ->
        // request_control. This provider is a transport E2E, not real reasoning.
        const fixtureTarget = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'e2e-computer-target.json'), 'utf8'))
        const lastToolObject = () => {
          for (const message of [...messages].reverse()) if (message.role === 'tool') {
            for (const block of message.content ?? []) if (block.type === 'text') { try { return JSON.parse(block.text) } catch {} }
          }
        }
        if (stage === 0) {
          if (tools.some(tool => tool.name === 'run_code')) {
            if(passiveInputSource)throw Error('PASSIVE_SOURCE_NATIVE_TOOLS_REQUIRED')
            submittedComputers.set(key, 7)
            const code = `const found = await tools.qiuya_computer_discover({query:${JSON.stringify(fixtureTarget.query)}}); const candidate = found.applications.find(app => app.appName === ${JSON.stringify(fixtureTarget.query)}); if (!candidate) throw new Error('E2E_APPLICATION_NOT_DISCOVERED'); const granted = await tools.qiuya_computer_request_control({candidateId:candidate.candidateId,reason:'在当前测试聊天操作本次专用测试窗口，验证图片与鼠标工具链'}); const windows = await tools.qiuya_computer_targets({}); if (!windows.targets.some(target => target.id === ${JSON.stringify(fixtureTarget.targetId)})) throw new Error('E2E_FIXTURE_TARGET_NOT_PERMITTED'); await tools.qiuya_computer_select({targetId:${JSON.stringify(fixtureTarget.targetId)}}); const before = await tools.qiuya_computer_observe({}); const action = await tools.qiuya_computer_act({frameId:before.frameId,actionId:'fixture-agent-move',action:{kind:'move',x:Math.floor(before.width/2),y:Math.floor(before.height/2)}}); const after = await tools.qiuya_computer_observe({}); return {granted,action,after};`
            yield *call('run_code', { code, description: '从当前聊天发现测试应用，等待用户授权，再观察、操作和验证' }); return
          }
          if (tools.some(tool => tool.name === 'qiuya_computer_discover')) { submittedComputers.set(key, 1); yield *call('qiuya_computer_discover', { query: fixtureTarget.query }); return }
          yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_TOOL_UNAVAILABLE' }
        } else if (stage === 1) {
          const discovery = lastToolObject(), candidate = discovery?.applications?.find(app => app.appName === fixtureTarget.query)
          if (!candidate) { yield { type: 'text-delta', index: 0, text: 'E2E_APPLICATION_NOT_DISCOVERED' } }
          else { submittedComputers.set(key, 2); yield *call('qiuya_computer_request_control', { candidateId: candidate.candidateId, reason: '在当前测试聊天操作本次专用测试窗口，验证图片与鼠标工具链' }); return }
        } else if (stage === 2) {
          submittedComputers.set(key, 3); yield *call('qiuya_computer_targets', {}); return
        } else if (stage === 3) {
          const targets = lastToolObject()?.targets ?? []
          if (!targets.some(target => target.id === fixtureTarget.targetId)) { yield { type: 'text-delta', index: 0, text: 'E2E_FIXTURE_TARGET_NOT_PERMITTED' } }
          else { submittedComputers.set(key, 4); yield *call('qiuya_computer_select', { targetId: fixtureTarget.targetId }); return }
        } else if (stage === 4) {
          if(passiveInputSource&&!await passiveInputSource.prepare(fixtureTarget.targetId,fixtureTarget.targetPid)){yield {type:'text-delta',index:0,text:'E2E_PASSIVE_SOURCE_DIAGNOSTIC_UNAVAILABLE'};yield {type:'finish',reason:{kind:'stop'}};return}
          submittedComputers.set(key, 5); yield *call('qiuya_computer_observe', {}); return
        } else if (stage === 5) {
          const observationText = [...messages].reverse().filter(message => message.role === 'tool').map(textOf).join('\n')
          const frameId = observationText.match(/"frameId"\s*:\s*"([^"\\]+)"/u)?.[1]
          const image = images.at(-1)
          if (frameId && image && tools.some(tool => tool.name === 'qiuya_computer_act')) {
            if(passiveInputSource&&!await passiveInputSource.start({frameId,targetId:fixtureTarget.targetId})){yield {type:'text-delta',index:0,text:'E2E_PASSIVE_SOURCE_DIAGNOSTIC_UNAVAILABLE'};yield {type:'finish',reason:{kind:'stop'}};return}
            submittedComputers.set(key, 6)
            yield *call('qiuya_computer_act', { frameId, actionId: 'fixture-agent-move', action: { kind: 'move', x: Math.floor(image.width / 2), y: Math.floor(image.height / 2) } }); return
          }
          yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_FRAME_MISSING' }
        } else if (stage === 6) {
          if(passiveInputSource&&!await passiveInputSource.finish()){yield {type:'text-delta',index:0,text:'E2E_PASSIVE_SOURCE_DIAGNOSTIC_UNAVAILABLE'};yield {type:'finish',reason:{kind:'stop'}};return}
          if (!actionResults.some(result => result.performed)) { yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_ACTION_FAILED' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
          submittedComputers.set(key, 7); yield *call('qiuya_computer_observe', {}); return
        } else {
          yield { type: 'text-delta', index: 0, text: images.length ? `E2E_ADAPTER_IMAGE_CONFIRMED:${images.length}` : 'E2E_COMPUTER_IMAGE_MISSING' }
        }
      } else if (text.startsWith('E2E:plan') && !submittedPlans.has(key)) {
        submittedPlans.add(key)
        // Leave the real composer available briefly so the browser can seed a
        // human draft before the official pending-plan surface replaces it.
        await delay(1000, options.signal)
        const tools = options.tools ?? []
        const native = tools.find(tool => tool.name === 'exit_plan_mode')
        const ptc = tools.find(tool => tool.name === 'run_code')
        if (native || ptc) {
          const name = native ? 'exit_plan_mode' : 'run_code'
          const args = native ? { plan } : { code: `return await tools.exit_plan_mode(${JSON.stringify({ plan })})`, description: '提交本地测试计划' }
          yield *call(name, args); return
        }
        yield { type: 'text-delta', index: 0, text: 'E2E_PLAN_TOOL_UNAVAILABLE' }
      } else {
        const answer = text.includes('E2E:slow') ? '本地慢速回复用于验证中断。'.repeat(8) : `已完成本地测试回复：${text.slice(0, 180) || '继续检查测试结果。'}`
        for (let start = 0; start < answer.length; start += 12) {
          if (options.signal?.aborted) throw options.signal.reason
          yield { type: 'text-delta', index: 0, text: answer.slice(start, start + 12) }
          await delay(text.includes('E2E:slow') ? 150 : 10, options.signal)
        }
      }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
}
