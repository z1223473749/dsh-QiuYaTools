/** Test-only policy. No credentials, profile access, model calls or GUI. */
import { createHash } from 'node:crypto'
/** Final evidence obeys the same authorization boundary as model screenshots.
 * Capture/write callbacks must never run for a natural task without approval. */
export async function persistVisionFinalImage({ testOnlyNaturalEntry, approved }, capture, write) {
  if (testOnlyNaturalEntry === true && approved !== true) return { finalImageUnavailable: true, finalImageSkipped: 'natural-entry-not-approved' }
  try { await write(await capture()); return {} } catch { return { finalImageUnavailable: true } }
}
export const VISION_TOOLS = Object.freeze(['qiuya_computer_observe', 'qiuya_computer_act', 'qiuya_computer_status', 'qiuya_computer_pause'])
export const NATURAL_VISION_TOOLS = Object.freeze(['qiuya_computer_discover', 'qiuya_computer_request_control', ...VISION_TOOLS])
export function naturalVisionPrompt(appName) {
  if (typeof appName !== 'string' || !appName || appName.length > 160 || /[\x00-\x1f\x7f"<>\\/]/u.test(appName)) throw Error('VISION_NATURAL_APPLICATION')
  return `请在本次验收应用“${appName}”中找到绿色“确认本单”并点击一次，核对结果后告诉我画面上的核验码，完成后暂停。需要操控权限时请向我申请。`
}
export function visionPreauthorizationPassed(proof, { sessionId, auditSha256 } = {}) {
  const audit = proof?.desktopAudit, calls = proof?.nativeCalls
  return proof?.phase === 'before-owner-once' && ['observe', 'preview', 'lease', 'act'].every(key => calls?.[key] === 0) &&
    audit?.sessionId === sessionId && audit?.auditSourceSha256 === auditSha256 && /^[a-f0-9]{64}$/u.test(auditSha256 ?? '') && audit?.userInteractive === true &&
    audit?.activeDesktopAccessible === true && audit?.activeDesktopMatches === true && audit?.heldKeyCount === 0 && audit?.leaseScopeExists === true && audit?.leaseFree === true && audit?.journalPresent === false
}
export function visionApprovalReadback(approval, session) {
  const override = session && typeof approval?.overrideOf === 'function' ? approval.overrideOf(session) : undefined
  const effective = override ?? approval?.config?.policy
  // Match the production canRequest predicate exactly. Missing policy is its
  // default, not a new approval policy invented by this test-only runner.
  return { explicitNever: effective === 'never', effectivePresent: effective !== undefined, allowedNewRequests: effective !== 'never', source: override !== undefined ? 'session-override' : effective !== undefined ? 'configured-default' : 'absent-default' }
}
export const VISION_DIAGNOSTIC_PHASES = Object.freeze(['unknown', 'prepare-start', 'fixture-directory', 'fixture-copy', 'fixture-metadata', 'fixture-launch', 'fixture-ready', 'external-wait', 'native-status', 'fixture-target', 'pair-server', 'pair-identity', 'model-selection', 'agent-create', 'agent-setup', 'tool-publication', 'prepare-complete', 'owner-settings-read', 'owner-enable', 'owner-status', 'owner-prepare', 'owner-connect', 'owner-start', 'owner-arm', 'owner-prompt', 'owner-wait', 'owner-finish', 'owner-reset-local', 'owner-restore-connection', 'owner-restore-flags', 'owner-delivery', 'owner-cancel-run'])
export const VISION_DIAGNOSTIC_CODES = Object.freeze(['VISION_NATURAL_APPROVAL_POLICY', 'VISION_NATURAL_CONFIGURATION', 'VISION_NATURAL_APPLICATION', 'VISION_NATURAL_PREAUTH_IMAGE', 'VISION_NATURAL_PREAUTH_AUDIT', 'VISION_NATURAL_NOT_APPROVED', 'VISION_NATURAL_NOT_IDLE', 'VISION_NATURAL_DISCOVERY', 'VISION_NATURAL_REQUEST', 'VISION_NATURAL_APPROVAL', 'VISION_NATURAL_OWNER_RPC', 'VISION_NATURAL_ALLOWLIST', 'VISION_ACCESSIBILITY_ANSWER_LEAK', 'VISION_ACTION_NOT_ALLOWED', 'VISION_AGENT_DISPOSE_FAILED', 'VISION_AGENT_DRAIN_TIMEOUT', 'VISION_ALREADY_ARMED', 'VISION_BODY_BOUND', 'VISION_CALLER_CHANGED', 'VISION_CLEANUP_FAILED', 'VISION_CONFIG_REQUIRED', 'VISION_CONNECTION_RESTORE_FAILED', 'VISION_DEADLINE', 'VISION_DELIVERY_FAILED', 'VISION_DELIVERY_STATE', 'VISION_EXTRA_TOOL_SCHEMA', 'VISION_FEATURE_RESTORE_FAILED', 'VISION_FEATURE_ENABLE_UNCONFIRMED', 'VISION_CANCEL_NOT_IDLE', 'VISION_CARRIER_CANCEL_UNCONFIRMED', 'VISION_FIXTURE_EXIT_UNCONFIRMED', 'VISION_FIXTURE_IDENTITY', 'VISION_FIXTURE_NATURAL_EXIT_FAILED', 'VISION_FIXTURE_PROTOCOL', 'VISION_FIXTURE_RETIRED', 'VISION_FIXTURE_STARTUP', 'VISION_FIXTURE_TARGET_MISSING', 'VISION_KEY_NOT_ALLOWED', 'VISION_MAC_REQUIRED', 'VISION_NATIVE_CLEANUP_FAILED', 'VISION_NATIVE_UNAVAILABLE', 'VISION_NATIVE_SCREEN_PERMISSION', 'VISION_NATIVE_ACCESSIBILITY_PERMISSION', 'VISION_NOT_ACTIVE', 'VISION_NOT_PREPARED', 'VISION_OBSERVATION_CHANGED', 'VISION_OPERATION_NOT_ALLOWED', 'VISION_ORACLE_TIMEOUT', 'VISION_PAIR_CLOSE_FAILED', 'VISION_PAIR_REVOKE_FAILED', 'VISION_POLICY_CONFIGURATION', 'VISION_PREVIEW_NOT_EXPOSED', 'VISION_PRODUCTION_TOOLS_MISSING', 'VISION_PUBLIC_RPC_FAILED', 'VISION_AUTORUN_SCOPE', 'VISION_AUTORUN_OWNER_CHANGED', 'VISION_AUTORUN_CANCELLED', 'VISION_SETTINGS_SNAPSHOT_INVALID', 'settings/rejected', 'settings/conflict', 'gateway/arguments-invalid', 'gateway/bad-request', 'gateway/permission-denied', 'gateway/forbidden', 'gateway/service-unavailable', 'gateway/cancelled', 'gateway/internal', 'gateway/method-not-found', 'VISION_REMOTE_RELEASE_UNCONFIRMED', 'VISION_REQUEST_LIMIT', 'VISION_REQUIRES_IDLE_LOCAL_CONNECTION', 'VISION_ROUTE_CHANGED', 'VISION_SCREENSHOT_ATTACHMENT_MISSING', 'VISION_SELECTED_TARGET_CHANGED', 'VISION_SESSION_NOT_OWNED', 'VISION_STEP_LIMIT', 'VISION_TARGET_CHANGED', 'VISION_TASK_ALREADY_SETTLED', 'VISION_TASK_SEQUENCE', 'VISION_TEST_FAILED', 'VISION_TURN_ERROR', 'VISION_WORKING_DIRECTORY_BOUNDARY', 'VISION_TEXT_BOUND', 'VISION_TOOL_NOT_ALLOWED', 'VISION_TOOL_PUBLICATION_BOUNDARY', 'VISION_WRITABLE_FEATURE_SETTING_REQUIRED', 'VISION_DIAGNOSTIC_WRITE_FAILED', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'NATIVE_START_FAILED', 'NATIVE_DISCONNECTED', 'NATIVE_PROTOCOL', 'NATIVE_PROTOCOL_VERSION', 'NATIVE_PIPE_FAILED', 'NATIVE_TIMEOUT', 'PAIR_UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE', 'VISION_EXTERNAL_BINDING', 'VISION_EXTERNAL_CONFIG', 'VISION_EXTERNAL_FILE_BOUNDARY', 'VISION_EXTERNAL_REPLAY', 'VISION_EXTERNAL_FIXTURE_CHANGED', 'VISION_EXTERNAL_SOURCE_CHANGED', 'VISION_EXTERNAL_IDENTITY', 'VISION_EXTERNAL_ORACLE', 'VISION_EXTERNAL_ORACLE_TIMEOUT', 'VISION_EXTERNAL_NATIVE_PERMISSION', 'VISION_EXTERNAL_REMAINS', 'VISION_EXTERNAL_DEADLINE', 'VISION_EXTERNAL_FAILED', 'VISION_EXTERNAL_CLEANUP_FAILED'])
/** Finite identifiers only: exception messages/stacks/causes may contain paths,
 * credentials or business data and are never diagnostic evidence. */
export function projectVisionFailure(error, phase = 'unknown') {
  const code = VISION_DIAGNOSTIC_CODES.includes(error?.code) ? error.code : 'VISION_TEST_FAILED'
  const category = code.startsWith('settings/') || code.startsWith('gateway/') ? 'public-rpc' : code.startsWith('VISION_') && code !== 'VISION_TEST_FAILED' ? 'test-policy'
    : ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO'].includes(code) ? 'filesystem'
      : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'PAIR_UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE'].includes(code) ? 'transport'
        : code.startsWith('NATIVE_') ? 'native' : error instanceof TypeError ? 'type-error' : error instanceof SyntaxError ? 'syntax-error' : 'unclassified'
  return { phase: VISION_DIAGNOSTIC_PHASES.includes(phase) ? phase : 'unknown', code, category }
}
export function projectVisionNativeStatus(value) {
  const permissions = Object.fromEntries(['screenRecording', 'accessibility', 'postEvents', 'inputMonitoring'].map(key => [key, typeof value?.permissions?.[key] === 'boolean' ? value.permissions[key] : null]))
  return { available: typeof value?.available === 'boolean' ? value.available : null, platform: ['darwin', 'win32'].includes(value?.platform) ? value.platform : 'unknown', protocolVersion: value?.protocolVersion === 1 ? 1 : null, permissions }
}
const runtimeFailureCodes = new Set(['FOCUS_CHANGED', 'GEOMETRY_CHANGED', 'HUMAN_INPUT_INTERRUPTED', 'CONTROL_CHANGED', 'STALE_OBSERVATION', 'STALE_FRAME', 'FRAME_EXPIRED', 'TARGET_GONE', 'TARGET_CHANGED', 'SESSION_PAUSED', 'OWNER_RESUME_REQUIRED', 'INPUT_CLEANUP_FAILED', 'CURSOR_CLEANUP_FAILED', 'ABORTED', 'INVALID_ACTION', 'NO_FRAME'])
const focusStages = new Set(['not-requested', 'focused-window', 'focused-window-geometry', 'component-hit', 'component-window', 'component-role', 'component-parent', 'component-geometry', 'logical-root-hit', 'logical-root-geometry', 'complete'])
/** Failed tool calls must remain failures. Retain bounded native metadata,
 * never the exception message/stack, target identity or accessibility text. */
export function projectVisionRuntimeFailure(error, status) {
  const attempt = status?.focusAttempt
  const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 0x7fffffff ? value : null
  const bool = value => typeof value === 'boolean' ? value : null
  return {
    code: runtimeFailureCodes.has(error?.code) || VISION_DIAGNOSTIC_CODES.includes(error?.code) ? error.code : 'unclassified',
    nativeStatusAvailable: status?.available === true,
    focus: attempt && typeof attempt === 'object' ? {
      preparationPhase: ['request', 'readiness', 'ready'].includes(attempt.preparationPhase) ? attempt.preparationPhase : 'unknown',
      componentProofStage: focusStages.has(attempt.componentProofStage) ? attempt.componentProofStage : 'unknown',
      componentIdentityMode: ['none', 'child-frame', 'focused-logical-root'].includes(attempt.componentIdentityMode) ? attempt.componentIdentityMode : 'unknown',
      inputRoute: ['metadata', 'pointer', 'keyboard'].includes(attempt.inputRoute) ? attempt.inputRoute : 'unknown',
      inputRouteStage: ['not-requested', 'metadata', 'pointer-route', 'keyboard-root', 'metadata-recheck', 'checked', 'deadline'].includes(attempt.inputRouteStage) ? attempt.inputRouteStage : 'unknown',
      keyboardFocusStage: ['not-requested', 'focused-window', 'owner', 'geometry', 'role', 'root-recheck', 'checked', 'deadline'].includes(attempt.keyboardFocusStage) ? attempt.keyboardFocusStage : 'unknown',
      ...Object.fromEntries(['settledMs', 'readinessSamples', 'consecutiveReadinessSamples', 'metadataSamples', 'componentProofCalls', 'componentProofMs', 'acceptedComponentProofs', 'componentAXError', 'logicalRootPoints', 'axSettableResult', 'axFrontmostResult', 'raiseResult', 'inputRouteChecks', 'inputRouteMs', 'keyboardFocusSamples', 'keyboardAXError', 'keyboardSampleMs', 'keyboardTransientAXRetries', 'keyboardReadinessRetries', 'keyboardRetryBudgetRemainingMs', 'keyboardRetryIdentityChecks', 'keyboardPostAwaitIdentityChecks'].map(key => [key, integer(attempt[key])])),
      inputPosted: bool(attempt.inputPosted), activationAccepted: bool(attempt.activationAccepted), inputRouteAccepted: bool(attempt.inputRouteAccepted), keyboardFocusAccepted: bool(attempt.keyboardFocusAccepted),
      keyboardSampleDeadlineExceeded: bool(attempt.keyboardSampleDeadlineExceeded), keyboardSampleReadyExpired: bool(attempt.keyboardSampleReadyExpired), keyboardIndependentIdentityAccepted: bool(attempt.keyboardIndependentIdentityAccepted), keyboardReadyProofExpired: bool(attempt.keyboardReadyProofExpired),
    } : null,
  }
}
export async function withVisionFailureEvidence(run, readStatus, record) {
  try { return await run() } catch (error) {
    let timer, status
    try { status = await Promise.race([Promise.resolve().then(readStatus), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('bounded status diagnostic')), 1000) })]) } catch {} finally { clearTimeout(timer) }
    // Evidence collection cannot replace the original rejection or replay it.
    try { record(projectVisionRuntimeFailure(error, status)) } catch {}
    throw error
  }
}
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const syntheticHash = text => createHash('sha256').update(text).digest('hex')
/** Only the exact owned turn/end LlmFailure reaches this projection. No raw
 * message, request ID, provider payload, token, path or arbitrary type is kept. */
export function projectVisionTurnError(error) {
  const codes = ['UNKNOWN', 'AUTHENTICATION_FAILED', 'AUTHENTICATION_REQUIRED', 'INVALID_API_KEY', 'UNAUTHORIZED', 'FORBIDDEN', 'MODEL_NOT_FOUND', 'PROVIDER_NOT_FOUND', 'RATE_LIMITED', 'CONTEXT_LENGTH_EXCEEDED', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'IMAGE_OFFLOAD_REQUIRED']
  const code = codes.includes(error?.code) || VISION_DIAGNOSTIC_CODES.includes(error?.code) ? error.code : null
  const message = typeof error?.message === 'string' ? error.message : null
  const categories = message === null ? [] : [
    ['workspace-missing', /working-directory:\s*directory does not exist/iu],
    ['tool-publication-boundary', /VISION_TOOL_PUBLICATION_BOUNDARY/u],
    ['model-not-found', /ModelNotFound|model[ _-]not[ _-]found/iu],
    ['provider-not-found', /provider[ _-]not[ _-]found/iu],
    ['authentication', /authentication|unauthorized|invalid[ _-](?:api[ _-])?key/iu],
  ].filter(([, pattern]) => pattern.test(message)).map(([name]) => name)
  return { code, unknownCodeSHA: code === null && typeof error?.code === 'string' ? syntheticHash(error.code) : null,
    status: Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : null,
    type: ['authentication', 'rate-limit', 'timeout', 'transport', 'unknown'].includes(error?.type) ? error.type : null,
    messageSHA: message === null ? null : syntheticHash(message), messageBytes: message === null ? null : Buffer.byteLength(message), categories }
}
export function projectVisionToolSchema(tool) {
  const description = tool?.description; let serialized
  try { serialized = tool?.parameters === undefined ? undefined : JSON.stringify(tool.parameters) } catch {}
  return { name: NATURAL_VISION_TOOLS.includes(tool?.name) ? tool.name : 'other',
    descriptionPresent: typeof description === 'string', ...(typeof description === 'string' ? { descriptionLength: description.length, descriptionSha256: syntheticHash(description) } : {}),
    parametersPresent: tool?.parameters !== undefined, parametersSerializable: typeof serialized === 'string',
    ...(typeof serialized === 'string' ? { parametersBytes: Buffer.byteLength(serialized), parametersSha256: syntheticHash(serialized) } : {}) }
}
/** The SDK distinguishes visible TextBlock from ReasoningBlock. Never inspect
 * raw stream/chunks, provider metadata or tool-call arguments for this oracle. */
export function visionAssistantDisplayEvidence(session, expectedSessionId) {
  if (!expectedSessionId || session?.id !== expectedSessionId || typeof session.snapshotEvents !== 'function') fail('VISION_SESSION_NOT_OWNED')
  const all = session.snapshotEvents(), events = all.slice(-512), messages = []; let remaining = 32768, remainingSerialized = 49152, truncated = all.length > events.length, attempts = 0, assistantMessages = 0
  for (const event of [...events].reverse()) {
    if (event.type === 'assistant/attempt') { attempts++; continue }
    if (event.type !== 'assistant/message' || event.data?.message?.role !== 'assistant') continue
    assistantMessages++
    if (messages.length >= 32) { truncated = true; continue }
    const text = (event.data.message.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    const bytes = Buffer.from(text); let accepted = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true })
    if (bytes.length > remaining) truncated = true
    while (accepted && Buffer.byteLength(JSON.stringify(accepted)) > remainingSerialized) {
      accepted = new TextDecoder().decode(Buffer.from(accepted).subarray(0, Math.floor(Buffer.byteLength(accepted) / 2)), { stream: true }); truncated = true
    }
    remainingSerialized = Math.max(0, remainingSerialized - Buffer.byteLength(JSON.stringify(accepted)))
    const size = Buffer.byteLength(accepted); remaining -= size
    messages.push({ seq: Number.isSafeInteger(event.seq) ? event.seq : null, turn: Number.isSafeInteger(event.data.turn) ? event.data.turn : null,
      step: Number.isSafeInteger(event.data.step) ? event.data.step : null, interrupted: event.data.interrupted === true, text: accepted })
  }
  messages.reverse()
  const display = messages.map(row => row.text).join('\n'), summary = { status: 'collected', assistantMessages, nonSurfaceAttempts: attempts, retainedMessages: messages.length,
    displayCharacters: messages.reduce((sum, row) => sum + row.text.length, 0), displayUtf8Bytes: messages.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0),
    displaySha256: syntheticHash(display), truncated, classes: { withText: messages.filter(row => row.text.length > 0).length, withoutText: messages.filter(row => !row.text).length, interrupted: messages.filter(row => row.interrupted).length } }
  return { summary, privateEvidence: { version: 1, sessionId: expectedSessionId, messages, excludes: ['reasoning', 'thinking', 'raw-stream', 'provider-metadata', 'tool-call-arguments'] } }
}
const actionFields = Object.freeze(['action', 'frameId', 'kind', 'text', 'key', 'x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'button'])
const actionKinds = Object.freeze(['click', 'move', 'drag', 'scroll', 'type', 'key'])
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : ['object', 'string', 'number', 'boolean', 'undefined'].includes(typeof value) ? typeof value : 'other'
function projectedFields(value) {
  const object = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries(actionFields.map(key => {
    const present = Object.hasOwn(object, key), field = object[key]
    return [key, { present, type: present ? valueType(field) : 'absent', ...(present && typeof field === 'string' ? { length: field.length, sha256: syntheticHash(field) } : {}) }]
  }))
}
/** Finite field names/types only; rejected kind/key/text values never enter logs. */
export function projectVisionActionDenial(args) {
  const action = args?.action, kind = action?.kind
  return { argumentsType: valueType(args), actionType: valueType(action),
    kindClass: actionKinds.includes(kind) ? kind : typeof kind === 'string' ? 'unsupported-string' : valueType(kind),
    argumentFields: projectedFields(args), actionFields: projectedFields(action),
    unknownArgumentKeyCount: args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).filter(key => !actionFields.includes(key)).length : 0,
    unknownActionKeyCount: action && typeof action === 'object' && !Array.isArray(action) ? Object.keys(action).filter(key => !actionFields.includes(key)).length : 0 }
}
export function visionActionUsage(task) {
  const common = '电脑工具参数：先 observe 取得最新 frameId；act 使用 {frameId, action:{kind,...}}。坐标 x、y、toX、toY 都从当前截图读取并使用截图局部坐标。'
  if (task === 1) return common + ' 点击按钮的 action.kind 为 "click"，同时提供 x、y。'
  if (task === 2) return common + ' 点击文本框使用 action.kind="click" 和 x、y；输入完整文字使用 action.kind="type"、action.text="你从截图逐字读到的文本"；提交回车使用 action.kind="key"、action.key="Enter"。'
  if (task === 3) return common + ' 拖拽使用 action.kind="drag"，提供起点 x、y 和终点 toX、toY。'
  fail('VISION_TASK_SEQUENCE')
}
export function sameVisionTarget(actual, expected) {
  return actual?.id === expected.id && actual?.pid === expected.pid && actual?.appId === expected.appId
}
export function assertVisionAnswerHidden(elements, syntheticNonce) {
  if (typeof elements !== 'string' || typeof syntheticNonce !== 'string' || !syntheticNonce || elements.toUpperCase().includes(syntheticNonce.toUpperCase())) fail('VISION_ACCESSIBILITY_ANSWER_LEAK')
  return true
}
export function projectVisionRequest(options) {
  return { provider: options.provider, model: options.model, tools: (options.tools ?? []).map(tool => tool.name), toolSchemas: (options.tools ?? []).map(projectVisionToolSchema),
    images: (options.messages ?? []).flatMap(message => (message.content ?? []).filter(block => block.type === 'image').map(block => ({
      attachmentId: block.attachment?.attachmentId, mediaType: block.attachment?.mediaType, width: block.attachment?.width,
      height: block.attachment?.height, bytes: block.attachment?.bytes, offloaded: block.offloaded === true,
    }))) }
}
export function projectVisionTool(name, args, result) {
  const action = args?.action
  return { name, ...(args?.frameId ? { frameId: args.frameId } : {}), ...(action ? { action: {
    kind: action.kind, ...Object.fromEntries(['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY', 'button', 'key'].filter(key => action[key] !== undefined).map(key => [key, action[key]])),
    ...(typeof action.text === 'string' ? { textLength: action.text.length, textSha256: syntheticHash(action.text) } : {}),
  } } : {}), ...(result ? { isError: result.isError === true, ...(result.image?.attachmentId ? { imageAttachmentId: result.image.attachmentId } : {}) } : {}) }
}
export class VisionPolicy {
  constructor({ sessionId, target, task, selection, now = Date.now, maxRequests = 12, deadlineMs = 180000, testOnlyNaturalEntry = false }) {
    if (!/^qiuya-vision-[a-f0-9-]{36}$/u.test(sessionId) || ![1, 2, 3].includes(task) || maxRequests !== 12 || deadlineMs !== 180000) fail('VISION_POLICY_CONFIGURATION')
    this.sessionId = sessionId; this.target = { ...target }; this.task = task; this.selection = { provider: selection.provider, model: selection.model }
    if (typeof testOnlyNaturalEntry !== 'boolean' || testOnlyNaturalEntry && task !== 1) fail('VISION_POLICY_CONFIGURATION')
    this.testOnlyNaturalEntry = testOnlyNaturalEntry; this.toolNames = testOnlyNaturalEntry ? NATURAL_VISION_TOOLS : VISION_TOOLS
    this.entry = testOnlyNaturalEntry ? { candidateId: null, requested: false, approved: false, ownerOnce: null } : null
    this.now = now; this.maxRequests = maxRequests; this.deadlineMs = deadlineMs; this.startedAt = 0; this.steps = 0; this.requests = []; this.tools = []; this.denials = []; this.observedImageIds = new Set(); this.ended = false
  }
  arm() { if (this.startedAt || this.ended) fail('VISION_ALREADY_ARMED'); this.startedAt = this.now() || 1 }
  assertActive() {
    if (!this.startedAt || this.ended) fail('VISION_NOT_ACTIVE')
    if (this.now() - this.startedAt >= this.deadlineMs) fail('VISION_DEADLINE')
  }
  enterStep() { this.assertActive(); if (this.steps >= 12) fail('VISION_STEP_LIMIT'); this.steps++ }
  recordObservation(value, syntheticNonce) {
    if (!this.initialAccessibilityAnswerHidden) this.initialAccessibilityAnswerHidden = assertVisionAnswerHidden(value.elements, syntheticNonce)
    if (typeof value.image?.attachmentId !== 'string' || !value.image.attachmentId) fail('VISION_SCREENSHOT_ATTACHMENT_MISSING')
    this.observedImageIds.add(value.image.attachmentId)
  }
  admitRequest(options) {
    this.assertActive()
    if (this.requests.length >= 12) fail('VISION_REQUEST_LIMIT')
    if (options.sessionId !== this.sessionId || options.provider !== this.selection.provider || options.model !== this.selection.model) fail('VISION_ROUTE_CHANGED')
    const projected = projectVisionRequest(options)
    if (projected.tools.some(name => !this.toolNames.includes(name))) fail('VISION_EXTRA_TOOL_SCHEMA')
    if (this.entry && !this.entry.approved && projected.images.length) fail('VISION_NATURAL_PREAUTH_IMAGE')
    this.requests.push({ attempt: this.requests.length + 1, at: this.now(), ...projected }); return projected
  }
  toolGuard(exec) {
    if (exec.agent?.id !== this.sessionId) return undefined
    try {
      this.assertActive()
      if (!this.toolNames.includes(exec.name)) fail('VISION_TOOL_NOT_ALLOWED')
      if (this.entry && !this.entry.approved && ['qiuya_computer_observe', 'qiuya_computer_act', 'qiuya_computer_pause'].includes(exec.name)) fail('VISION_NATURAL_NOT_APPROVED')
      if (exec.name === 'qiuya_computer_act') {
        const action = exec.arguments?.action
        const allowed = this.task === 1 ? ['click', 'move'] : this.task === 2 ? ['click', 'move', 'type', 'key'] : ['drag', 'move']
        if (!action || !allowed.includes(action.kind)) fail('VISION_ACTION_NOT_ALLOWED')
        if (action.kind === 'type' && (typeof action.text !== 'string' || action.text.length > 256)) fail('VISION_TEXT_BOUND')
        if (action.kind === 'key' && !['ENTER', 'RETURN', 'BACKSPACE', 'DELETE', 'CMD+A', 'LEFT', 'RIGHT'].includes(String(action.key).toUpperCase())) fail('VISION_KEY_NOT_ALLOWED')
      }
      return undefined
    } catch (error) {
      const code = projectVisionFailure(error).code
      this.denials.push({ at: this.now(), name: this.toolNames.includes(exec.name) ? exec.name : 'other', code,
        ...(exec.name === 'qiuya_computer_act' ? { parameters: projectVisionActionDenial(exec.arguments) } : {}) })
      return code
    }
  }
  recordDiscovery(result) {
    this.assertActive()
    if (!this.entry || this.entry.candidateId || result?.applications?.length !== 1) fail('VISION_NATURAL_DISCOVERY')
    const candidate = result.applications[0]
    if (candidate.granted !== false || typeof candidate.candidateId !== 'string' || !candidate.candidateId || !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= this.now()) fail('VISION_NATURAL_DISCOVERY')
    this.entry.candidateId = candidate.candidateId; this.entry.discoveredAt = this.now(); this.entry.grantedBefore = false
  }
  requestEntry(args) {
    this.assertActive()
    if (!this.entry || this.entry.requested || !this.entry.candidateId || args?.candidateId !== this.entry.candidateId) fail('VISION_NATURAL_REQUEST')
    this.entry.requested = true; this.entry.requestedAt = this.now()
  }
  recordOwnerOnce(proof) {
    this.assertActive()
    if (!this.entry?.requested || this.entry.ownerOnce || proof?.decision !== 'once' || proof?.state !== 'pending' || proof?.requestVersion !== 1 || typeof proof.requestId !== 'string' || !proof.requestId || proof?.allowedAppsUnchanged !== true || proof?.preauthorization?.passed !== true) fail('VISION_NATURAL_APPROVAL')
    this.entry.ownerOnce = { ...proof, driver: 'independent-trusted-test-driver-public-owner-rpc', simulatedOwnerDecision: true, humanClickProven: false, at: this.now() }
  }
  confirmOwnerOnce(proof) {
    this.assertActive()
    if (!this.entry?.ownerOnce || this.entry.ownerOnce.state !== 'pending' || proof?.requestId !== this.entry.ownerOnce.requestId || proof?.requestVersion !== 1 || proof?.decision !== 'once' || proof?.state !== 'approved' || proof?.allowedAppsUnchanged !== true) fail('VISION_NATURAL_APPROVAL')
    this.entry.ownerOnce.state = 'approved'; this.entry.ownerOnce.confirmedAt = this.now()
  }
  recordEntryReady(result, authorizedAppId) {
    this.assertActive()
    if (this.entry?.ownerOnce?.state !== 'approved' || result?.sessionId !== this.sessionId || !['ready', 'running'].includes(result?.state) || result.target?.id !== this.target.id || result.target?.pid !== this.target.pid || result.target?.appId !== authorizedAppId) fail('VISION_NATURAL_APPROVAL')
    this.entry.approved = true; this.entry.approvedAt = this.now()
  }
  finish() { this.ended = true }
  summary({ businessPassed, nonceRead, syntheticNonce }) {
    const images = this.requests.flatMap(request => request.images).filter(image => !image.offloaded)
    const ownImages = images.filter(image => this.observedImageIds.has(image.attachmentId))
    const naturalPassed = !this.entry || this.entry.grantedBefore === false && this.entry.requested && this.entry.approved && this.entry.ownerOnce?.state === 'approved' && this.entry.ownerOnce?.allowedAppsUnchanged === true && this.entry.ownerOnce?.preauthorization?.passed === true
    return { passed: naturalPassed && businessPassed && nonceRead && this.initialAccessibilityAnswerHidden === true && ownImages.length > 0 && this.requests.length > 0 && this.requests.length <= 12 && this.steps <= 12 && this.now() - this.startedAt < 180000 && this.denials.length === 0,
      ...(this.entry ? { naturalEntry: { ...this.entry, candidateId: this.entry.candidateId ? syntheticHash(this.entry.candidateId) : null, passed: naturalPassed } } : {}),
      sessionId: this.sessionId, task: this.task, steps: this.steps, requestAttempts: this.requests.length,
      durationMs: this.startedAt ? this.now() - this.startedAt : 0, businessPassed, visualNonceRead: nonceRead, initialAccessibilityAnswerHidden: this.initialAccessibilityAnswerHidden === true,
      syntheticNonceSha256: syntheticHash(syntheticNonce), retainedImageOccurrences: images.length, retainedFixtureImageOccurrences: ownImages.length, observedImageAttachmentIds: [...this.observedImageIds],
      model: this.selection, requests: this.requests, tools: this.tools, denials: this.denials }
  }
}
