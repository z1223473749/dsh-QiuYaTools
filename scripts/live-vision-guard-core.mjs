/** Test-only policy. No credentials, profile access, model calls or GUI. */
import { createHash } from 'node:crypto'
export const VISION_TOOLS = Object.freeze(['qiuya_computer_observe', 'qiuya_computer_act', 'qiuya_computer_status', 'qiuya_computer_pause'])
export const VISION_DIAGNOSTIC_PHASES = Object.freeze(['unknown', 'prepare-start', 'fixture-directory', 'fixture-copy', 'fixture-metadata', 'fixture-launch', 'fixture-ready', 'native-status', 'fixture-target', 'pair-server', 'pair-identity', 'model-selection', 'agent-create', 'agent-setup', 'tool-publication', 'prepare-complete', 'owner-settings-read', 'owner-enable', 'owner-status', 'owner-prepare', 'owner-connect', 'owner-start', 'owner-arm', 'owner-prompt', 'owner-wait', 'owner-finish', 'owner-reset-local', 'owner-restore-connection', 'owner-restore-flags', 'owner-delivery'])
export const VISION_DIAGNOSTIC_CODES = Object.freeze(['VISION_ACCESSIBILITY_ANSWER_LEAK', 'VISION_ACTION_NOT_ALLOWED', 'VISION_AGENT_DISPOSE_FAILED', 'VISION_AGENT_DRAIN_TIMEOUT', 'VISION_ALREADY_ARMED', 'VISION_BODY_BOUND', 'VISION_CALLER_CHANGED', 'VISION_CLEANUP_FAILED', 'VISION_CONFIG_REQUIRED', 'VISION_CONNECTION_RESTORE_FAILED', 'VISION_DEADLINE', 'VISION_DELIVERY_FAILED', 'VISION_DELIVERY_STATE', 'VISION_EXTRA_TOOL_SCHEMA', 'VISION_FEATURE_RESTORE_FAILED', 'VISION_FIXTURE_EXIT_UNCONFIRMED', 'VISION_FIXTURE_IDENTITY', 'VISION_FIXTURE_NATURAL_EXIT_FAILED', 'VISION_FIXTURE_PROTOCOL', 'VISION_FIXTURE_RETIRED', 'VISION_FIXTURE_STARTUP', 'VISION_FIXTURE_TARGET_MISSING', 'VISION_KEY_NOT_ALLOWED', 'VISION_MAC_REQUIRED', 'VISION_NATIVE_CLEANUP_FAILED', 'VISION_NATIVE_UNAVAILABLE', 'VISION_NATIVE_SCREEN_PERMISSION', 'VISION_NATIVE_ACCESSIBILITY_PERMISSION', 'VISION_NOT_ACTIVE', 'VISION_NOT_PREPARED', 'VISION_OBSERVATION_CHANGED', 'VISION_OPERATION_NOT_ALLOWED', 'VISION_ORACLE_TIMEOUT', 'VISION_PAIR_CLOSE_FAILED', 'VISION_PAIR_REVOKE_FAILED', 'VISION_POLICY_CONFIGURATION', 'VISION_PREVIEW_NOT_EXPOSED', 'VISION_PRODUCTION_TOOLS_MISSING', 'VISION_PUBLIC_RPC_FAILED', 'VISION_REMOTE_RELEASE_UNCONFIRMED', 'VISION_REQUEST_LIMIT', 'VISION_REQUIRES_IDLE_LOCAL_CONNECTION', 'VISION_ROUTE_CHANGED', 'VISION_SCREENSHOT_ATTACHMENT_MISSING', 'VISION_SELECTED_TARGET_CHANGED', 'VISION_SESSION_NOT_OWNED', 'VISION_STEP_LIMIT', 'VISION_TARGET_CHANGED', 'VISION_TASK_ALREADY_SETTLED', 'VISION_TASK_SEQUENCE', 'VISION_TEST_FAILED', 'VISION_TEXT_BOUND', 'VISION_TOOL_NOT_ALLOWED', 'VISION_TOOL_PUBLICATION_BOUNDARY', 'VISION_WRITABLE_FEATURE_SETTING_REQUIRED', 'VISION_DIAGNOSTIC_WRITE_FAILED', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'NATIVE_START_FAILED', 'NATIVE_DISCONNECTED', 'NATIVE_PROTOCOL', 'NATIVE_PROTOCOL_VERSION', 'NATIVE_PIPE_FAILED', 'NATIVE_TIMEOUT', 'PAIR_UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE'])
/** Finite identifiers only: exception messages/stacks/causes may contain paths,
 * credentials or business data and are never diagnostic evidence. */
export function projectVisionFailure(error, phase = 'unknown') {
  const code = VISION_DIAGNOSTIC_CODES.includes(error?.code) ? error.code : 'VISION_TEST_FAILED'
  const category = code.startsWith('VISION_') && code !== 'VISION_TEST_FAILED' ? 'test-policy'
    : ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EEXIST', 'ENOSPC', 'EIO'].includes(code) ? 'filesystem'
      : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'PAIR_UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE'].includes(code) ? 'transport'
        : code.startsWith('NATIVE_') ? 'native' : error instanceof TypeError ? 'type-error' : error instanceof SyntaxError ? 'syntax-error' : 'unclassified'
  return { phase: VISION_DIAGNOSTIC_PHASES.includes(phase) ? phase : 'unknown', code, category }
}
export function projectVisionNativeStatus(value) {
  const permissions = Object.fromEntries(['screenRecording', 'accessibility', 'postEvents', 'inputMonitoring'].map(key => [key, typeof value?.permissions?.[key] === 'boolean' ? value.permissions[key] : null]))
  return { available: typeof value?.available === 'boolean' ? value.available : null, platform: ['darwin', 'win32'].includes(value?.platform) ? value.platform : 'unknown', protocolVersion: value?.protocolVersion === 1 ? 1 : null, permissions }
}
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const syntheticHash = text => createHash('sha256').update(text).digest('hex')
export function sameVisionTarget(actual, expected) {
  return actual?.id === expected.id && actual?.pid === expected.pid && actual?.appId === expected.appId
}
export function assertVisionAnswerHidden(elements, syntheticNonce) {
  if (typeof elements !== 'string' || typeof syntheticNonce !== 'string' || !syntheticNonce || elements.toUpperCase().includes(syntheticNonce.toUpperCase())) fail('VISION_ACCESSIBILITY_ANSWER_LEAK')
  return true
}
export function projectVisionRequest(options) {
  return { provider: options.provider, model: options.model, tools: (options.tools ?? []).map(tool => tool.name),
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
  constructor({ sessionId, target, task, selection, now = Date.now, maxRequests = 12, deadlineMs = 180000 }) {
    if (!/^qiuya-vision-[a-f0-9-]{36}$/u.test(sessionId) || ![1, 2, 3].includes(task) || maxRequests !== 12 || deadlineMs !== 180000) fail('VISION_POLICY_CONFIGURATION')
    this.sessionId = sessionId; this.target = { ...target }; this.task = task; this.selection = { provider: selection.provider, model: selection.model }
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
    if (projected.tools.some(name => !VISION_TOOLS.includes(name))) fail('VISION_EXTRA_TOOL_SCHEMA')
    this.requests.push({ attempt: this.requests.length + 1, at: this.now(), ...projected }); return projected
  }
  toolGuard(exec) {
    if (exec.agent?.id !== this.sessionId) return undefined
    try {
      this.assertActive()
      if (!VISION_TOOLS.includes(exec.name)) fail('VISION_TOOL_NOT_ALLOWED')
      if (exec.name === 'qiuya_computer_act') {
        const action = exec.arguments?.action
        const allowed = this.task === 1 ? ['click', 'move'] : this.task === 2 ? ['click', 'move', 'type', 'key'] : ['drag', 'move']
        if (!action || !allowed.includes(action.kind)) fail('VISION_ACTION_NOT_ALLOWED')
        if (action.kind === 'type' && (typeof action.text !== 'string' || action.text.length > 256)) fail('VISION_TEXT_BOUND')
        if (action.kind === 'key' && !['ENTER', 'RETURN', 'BACKSPACE', 'DELETE', 'CMD+A', 'LEFT', 'RIGHT'].includes(String(action.key).toUpperCase())) fail('VISION_KEY_NOT_ALLOWED')
      }
      return undefined
    } catch (error) { this.denials.push({ at: this.now(), name: exec.name, code: error.code }); return error.code }
  }
  finish() { this.ended = true }
  summary({ businessPassed, nonceRead, syntheticNonce }) {
    const images = this.requests.flatMap(request => request.images).filter(image => !image.offloaded)
    const ownImages = images.filter(image => this.observedImageIds.has(image.attachmentId))
    return { passed: businessPassed && nonceRead && this.initialAccessibilityAnswerHidden === true && ownImages.length > 0 && this.requests.length > 0 && this.requests.length <= 12 && this.steps <= 12 && this.now() - this.startedAt < 180000 && this.denials.length === 0,
      sessionId: this.sessionId, task: this.task, steps: this.steps, requestAttempts: this.requests.length,
      durationMs: this.startedAt ? this.now() - this.startedAt : 0, businessPassed, visualNonceRead: nonceRead, initialAccessibilityAnswerHidden: this.initialAccessibilityAnswerHidden === true,
      syntheticNonceSha256: syntheticHash(syntheticNonce), retainedImageOccurrences: images.length, retainedFixtureImageOccurrences: ownImages.length, observedImageAttachmentIds: [...this.observedImageIds],
      model: this.selection, requests: this.requests, tools: this.tools, denials: this.denials }
  }
}
