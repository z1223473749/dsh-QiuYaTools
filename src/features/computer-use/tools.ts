import type { Context } from '@deepseek-ai/cordis'
import { ComputerError, parseComputerAction, requireIdentity } from './contract.ts'
import type { ComputerServiceFacade } from './environment-manager.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation } from './contract.ts'
import type { ComputerPermissionCoordinator } from './permission-coordinator.ts'

// Keep Host-only SDK augmentation out of the shared Client TypeScript graph.
// These structural public seams are verified against the actual SDK in tests.
export interface ComputerToolRunContext { callId: string; rootCallId?: string; agent?: { id: string; session?: unknown }; signal: AbortSignal }
export interface ComputerImageAttachmentRef { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string; originalDimensions?: { width: number; height: number } }
type Content = { type: 'text'; text: string } | { type: 'image'; attachment: ComputerImageAttachmentRef }
interface ComputerToolDefinition {
  name: string; description: string; parameters: object
  output: { schema: object; render(args: unknown, value: unknown): Content[] }
  execute(args: unknown, exec: ComputerToolRunContext): Promise<unknown>
}
interface ComputerToolServices {
  tools: { register(definition: ComputerToolDefinition): () => void }
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<ComputerImageAttachmentRef> }
}
export interface ComputerToolsRecorder {
  /** Observes one existing SDK saveImage reference, never captures another image. */
  observed(exec: ComputerToolRunContext, observation: ComputerObservation, image: ComputerImageAttachmentRef, capturedAt: number): Promise<unknown>
  /** Persist issued before dispatch; returning a closure never grants control. */
  issuing(exec: ComputerToolRunContext, request: Readonly<ComputerActionRequest>): Promise<((result: ComputerActionResult | undefined) => Promise<unknown>) | undefined>
}
export interface ComputerToolTasks {
  createTask(chatSessionId: string, label?: string): string
  resolveTask(chatSessionId: string, taskId?: string): string
  listTasks(chatSessionId: string): readonly { chatSessionId: string; taskId: string; taskLabel?: string }[]
}
export interface ComputerToolsOptions { onSelected?(exec: ComputerToolRunContext): void; recorder?: ComputerToolsRecorder; sessionId?: (exec: ComputerToolRunContext) => string | undefined; enabled?: () => boolean; entry?: ComputerPermissionCoordinator; tasks?: ComputerToolTasks }
const taskParameter = { type: 'string', description: 'Opaque taskId returned by qiuya_computer_task. Supply it explicitly for this task on every call. Omit it only for the default task; there is no last-selected task.' }
const noParameters = { type: 'object', properties: { taskId: taskParameter }, additionalProperties: false }
// The public SDK retains structured codes only for its own HarnessError class;
// PTC forwards just the message. Every tool boundary uses a finite vocabulary
// so models retain the code without receiving driver paths or exception text.
const entryErrors: Record<string, string> = {
  TASK_NOT_FOUND: '电脑任务不存在或不属于当前聊天，请列出当前聊天的任务。', TASK_LIMIT: '当前聊天的电脑任务已达上限，请用户清理闲置任务。', INVALID_TASK_LABEL: '任务名称必须是1至120个字符且不含控制字符。', TASKS_UNAVAILABLE: '当前环境尚未提供电脑多任务入口，请使用默认任务。',
  ABORTED: '当前工具调用已取消。', COMPUTER_ENTRY_FAILED: '电脑操控入口未能完成，请用户检查连接和权限。',
  INVALID_REQUEST: '电脑操控参数无效。', DISABLED: '电脑操控未启用。', DISPOSED: '电脑操控已关闭。',
  SESSION_REQUIRED: '必须从当前聊天的 Agent 调用电脑操控。', CALLER_NOT_LIVE: '发起请求的 Agent 已失效。', DELEGATED_CALLER: '请由当前聊天的主 Agent 申请操控。',
  OWNER_RESUME_REQUIRED: '会话已暂停或被接管，需要用户先恢复。', OWNER_SWITCH_REQUIRED: '需要用户先停止旧会话再切换应用。',
  REQUEST_CANCELLED: '授权请求已取消。', REQUEST_EXPIRED: '授权请求已超时，请重新发现应用。', REQUEST_STALE: '授权请求已失效，请重新发现应用。', CONTROL_CHANGED: '控制权或操作环境已变化，请重新申请。',
  CANDIDATE_EXPIRED: '应用候选已过期，请重新发现应用。', CALL_REPLAY_MISMATCH: '此调用编号已用于另一请求。',
  REQUEST_LIMIT: '待处理授权已达上限，请先处理已有请求。', REQUEST_PENDING: '当前聊天已有待处理授权，请等待用户决定。',
  APPROVAL_DISABLED: '当前聊天禁止新的交互授权。', APP_DENIED: '用户拒绝了应用操控授权。',
  DISCOVERY_UNAVAILABLE: '暂时无法发现应用，请用户检查电脑连接和系统权限。', SYSTEM_PERMISSION_REQUIRED: '需要用户打开系统设置并授予屏幕录制或辅助功能；请等待用户操作。',
  APPLICATION_WINDOW_REQUIRED: '应用没有可操控窗口，请用户打开窗口后重新申请。', APPLICATION_UNAVAILABLE: '此应用当前不可用，请重新发现应用。', APPLICATION_LAUNCH_UNSUPPORTED: '此环境需要用户先打开应用窗口。',
  APPLICATION_LAUNCH_UNCONFIRMED: '应用启动结果尚未确认，请由用户重新连接电脑后再继续。',
  TARGET_CHANGED: '应用窗口身份已变化，请重新发现应用并申请。', TARGET_GONE: '应用窗口已关闭，请重新发现应用。',
  SESSION_LIMIT: '电脑环境数量已达上限，请用户清理闲置环境。', ENVIRONMENT_RETIRING: '旧电脑环境尚未完成清理，请稍后重试。',
}
const toolErrors: Record<string, string> = {
  ...entryErrors,
  COMPUTER_TOOL_FAILED: '电脑工具未能完成，请核对当前状态；不要自动重复未确认的输入。',
  FOCUS_CHANGED: '目标窗口焦点已变化。请停止输入，等待用户确认目标窗口后重新观察；不要自动重放操作。',
  HUMAN_INPUT_INTERRUPTED: '检测到人工介入，本次输入已停止。请等待用户恢复电脑操控，不要自行重新开始或重放操作。',
  CURSOR_CLEANUP_FAILED: '指针或输入清理尚未确认，请等待用户检查，不要自动重试或继续输入。',
  FOREGROUND_HANDOFF_DENIED: 'Windows 未确认此次前台交接。请等待用户检查目标窗口后重新观察，不要自动重复输入。',
  FOREGROUND_HANDOFF_UNCONFIRMED: '前台交接结果尚未确认，执行器已停止。请等待用户重新连接并确认当前窗口，不要自动重复输入。',
  ...Object.fromEntries(['foreground-clock-invalid', 'foreground-identity-invalid', 'foreground-recipient-changed', 'foreground-ticket-invalid', 'foreground-sequence-invalid', 'foreground-ticket-pending', 'foreground-ticket-required', 'foreground-ticket-unexpected', 'foreground-release-invalid', 'foreground-recipient-mismatch', 'foreground-donor-changed', 'foreground-identity-unavailable', 'foreground-physical-held', 'foreground-process-exited', 'foreground-image-unavailable', 'foreground-parent-exited', 'foreground-parent-unavailable', 'foreground-desktop-unavailable', 'foreground-desktop-changed', 'foreground-handoff-unavailable', 'foreground-context-unavailable', 'foreground-not-released', 'foreground-journal-present', 'foreground-context-changed'].map(code => [code, '前台交接状态或执行器身份已变化。请等待用户确认或恢复后重新观察，不要自动重复输入。'])),
  STALE_OBSERVATION: '画面已失效。每次成功操作（含 click/type/key/move）都会消耗 frameId；请先 observe 取得新 frameId，再执行下一步。不要为刷新画面重复已成功的操作，也不要自动重放结果未确认的输入。',
  APP_NOT_ALLOWED: '应用尚未授权或授权已撤销，请等待用户授权。',
  SESSION_NOT_STARTED: '当前聊天尚未开始电脑操控，请先发现应用并申请授权。',
  DEVICE_BUSY: '此电脑当前由另一个会话控制，请等待用户处理。',
  TARGET_NOT_FOUND: '目标窗口当前不可用，请用户确认窗口后重新发现应用。',
  PREVIEW_OVERLAP: '预览挡住了操作位置，请用户调整预览后重新观察；不要重放未确认的输入。',
  ...Object.fromEntries(['STALE_EPOCH', 'NOT_READY', 'DISCONNECTED', 'NATIVE_LEASE_UNRELEASED', 'INPUT_BUSY', 'DESKTOP_BUSY', 'DESKTOP_LEASE_REQUIRED', 'desktop-busy', 'input-busy', 'human-input-pending', 'stale-epoch', 'foreground-changed', 'foreground-denied'].map(code => [code, '控制权或输入环境已变化。请等待用户确认或恢复后重新观察，不要自行恢复或重放操作。'])),
  ...Object.fromEntries(['CAPTURE_TIMEOUT', 'CAPTURE_BUSY', 'CAPTURE_CHANGED', 'CAPTURE_START_FAILED', 'CAPTURE_STOPPED', 'CAPTURE_UNAVAILABLE', 'TARGETS_UNAVAILABLE', 'capture-timeout', 'capture-busy', 'capture-unavailable', 'observation-required', 'OBSERVATION_REQUIRED', 'INVALID_OBSERVATION'].map(code => [code, '尚未取得可用的当前画面，请核对连接和权限后重新观察，不要使用旧截图输入。'])),
  ...Object.fromEntries(['SCREEN_RECORDING_REQUIRED', 'ACCESSIBILITY_REQUIRED', 'INPUT_MONITORING_REQUIRED', 'input-denied', 'human-monitor-unavailable'].map(code => [code, '需要用户检查电脑的系统权限；请等待用户处理，不要自行修改权限。'])),
  ...Object.fromEntries(['INVALID_ACTION', 'INVALID_COORDINATES', 'INVALID_KEY', 'INVALID_TARGET', 'INVALID_EPOCH', 'INVALID_ACTOR', 'INVALID_SELECTOR', 'OUT_OF_BOUNDS', 'ACTION_ID_CONFLICT', 'invalid-request', 'invalid-target', 'invalid-coordinate', 'invalid-coordinates', 'invalid-button', 'invalid-key', 'invalid-action', 'invalid-epoch', 'invalid-actor', 'geometry-changed', 'GEOMETRY_CHANGED', 'target-changed', 'target-unavailable'].map(code => [code, '操作参数或目标身份不再有效，请核对当前授权目标并重新观察。'])),
  ...Object.fromEntries(['NATIVE_TIMEOUT', 'NATIVE_UNAVAILABLE', 'NATIVE_EXITED', 'NATIVE_PIPE_FAILED', 'NATIVE_FAILED', 'NATIVE_FAILURE', 'NATIVE_PROTOCOL', 'NATIVE_PROTOCOL_VERSION', 'NATIVE_MESSAGE_LIMIT', 'NATIVE_CLEANUP_FAILED', 'INPUT_CLEANUP_FAILED', 'INPUT_JOURNAL_FAILED', 'INPUT_JOURNAL_INVALID', 'DESKTOP_LOCK_FAILED', 'EVENT_FAILED', 'input-cleanup-failed', 'input-journal-failed', 'input-journal-invalid', 'desktop-lock-failed', 'capture-worker-stuck', 'QUEUE_FULL', 'REMOTE_TIMEOUT', 'REMOTE_PROTOCOL', 'REMOTE_RESPONSE_LIMIT', 'PAIR_UNAUTHORIZED', 'VERSION_MISMATCH', 'PLATFORM_UNSUPPORTED'].map(code => [code, '电脑连接或输入清理尚未确认，请用户检查连接和当前状态，不要自动重复输入。'])),
  ...Object.fromEntries(['BROWSER_ACTION_UNSUPPORTED', 'BROWSER_DISCONNECTED', 'BROWSER_NOT_CONNECTED', 'BROWSER_CDP_FAILED', 'BROWSER_IMAGE_INVALID', 'BROWSER_PROTOCOL', 'BROWSER_TIMEOUT', 'BROWSER_QUEUE_FULL', 'BROWSER_NAVIGATION_FAILED', 'BROWSER_NAVIGATION_TIMEOUT', 'BROWSER_DRIVER_REQUIRED', 'BROWSER_NOT_INSTALLED', 'BROWSER_LAUNCH_FAILED', 'BROWSER_LAUNCH_TIMEOUT', 'BROWSER_CONNECT_FAILED', 'BROWSER_CLOSE_FAILED', 'BROWSER_CLEANUP_FAILED', 'ELEMENT_NOT_FOUND', 'SITE_NOT_ALLOWED'].map(code => [code, '浏览器操作未能完成，请核对已授权页面和当前状态，不要自动重放操作。'])),
}
function publicToolError(error: unknown, fallback = 'COMPUTER_TOOL_FAILED'): ComputerError {
  let candidate = ''
  try { if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') candidate = error.code } catch {}
  const code = Object.hasOwn(toolErrors, candidate) ? candidate : fallback
  return new ComputerError(code, `[${code}] ${toolErrors[code]}`)
}
async function toolRun<T>(exec: ComputerToolRunContext, run: () => T | Promise<T>, fallback?: string): Promise<T> {
  try { return await run() } catch (error) { throw publicToolError(exec.signal.aborted ? { code: 'ABORTED' } : error, fallback) }
}
async function entryRun<T>(exec: ComputerToolRunContext, run: () => T | Promise<T>): Promise<T> {
  return toolRun(exec, run, 'COMPUTER_ENTRY_FAILED')
}
function parameters(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ComputerError('INVALID_REQUEST', '工具参数无效')
  return value as Record<string, unknown>
}
/** Uses only the current Agent's public tool/attachment services; no model requests. */
export function installComputerTools(ctx: Context, service: ComputerServiceFacade, options: ComputerToolsOptions = {}): () => void {
  const services = ctx as Context & ComputerToolServices
  const session = (exec: ComputerToolRunContext, input: Record<string, unknown> = {}): string => {
    exec.signal.throwIfAborted()
    if (options.enabled?.() === false) throw new ComputerError('DISABLED', '电脑操控未启用')
    const chat = options.sessionId?.(exec) ?? exec.agent?.id
    if (!chat) throw new ComputerError('SESSION_REQUIRED', '电脑操控工具必须由当前会话的 Agent 调用')
    requireIdentity(chat, '聊天')
    const taskId = input.taskId === undefined ? undefined : requireIdentity(input.taskId, '电脑任务')
    if (!options.tasks) {
      if (taskId !== undefined) throw new ComputerError('TASKS_UNAVAILABLE', '电脑多任务入口不可用')
      return chat
    }
    const id = requireIdentity(options.tasks.resolveTask(chat, taskId), '电脑任务')
    if (taskId === undefined && id !== chat) throw new ComputerError('TASK_NOT_FOUND', '默认任务归属无效')
    return id
  }
  const bindSession = (exec: ComputerToolRunContext, input: Record<string, unknown>) => {
    if (input.taskId !== undefined) assertTaskCaller(exec)
    const id = session(exec, input), chat = options.sessionId?.(exec) ?? exec.agent?.id
    const taskId = input.taskId === undefined ? undefined : requireIdentity(input.taskId, '电脑任务')
    const isDefault = id === chat
    const assertCurrent = () => { if (taskId !== undefined) assertTaskCaller(exec); if (session(exec, input) !== id) throw new ComputerError('TASK_NOT_FOUND', '电脑任务归属已变化') }
    return { id, taskId, isDefault, assertCurrent }
  }
  const operationExecution = (exec: ComputerToolRunContext, operationSessionId: string) => ({ ...exec, operationSessionId })
  const taskResult = (value: object, taskId?: string) => ({ ...value, ...(taskId === undefined ? {} : { taskId }) })
  const taskLabel = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 120 || /[\x00-\x1f\x7f]/u.test(value)) throw new ComputerError('INVALID_TASK_LABEL', '电脑任务名称无效')
    return value.trim()
  }
  const assertTaskCaller = (exec: ComputerToolRunContext) => {
    if (!options.entry?.assertCaller) throw new ComputerError('TASKS_UNAVAILABLE', '电脑多任务入口不可用')
    options.entry.assertCaller(exec)
  }
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  const register = (definition: ComputerToolDefinition) => services.tools.register({ ...definition, execute: (args, exec) => toolRun(exec, () => definition.execute(args, exec)) })
  const unregister = [
    ...(options.tasks && options.entry ? [register({
      name: 'qiuya_computer_task', description: 'Create or list independent computer tasks in the calling chat only. Creating/listing only reserves or reads task identities; it does not launch applications, capture a screen, acquire control, or grant permission. Use the returned taskId explicitly on each later computer tool call. Omitting taskId always uses the default task, never the last-selected task.',
      parameters: { type: 'object', additionalProperties: false, required: ['op'], properties: { op: { type: 'string', enum: ['create', 'list'] }, label: { type: 'string', minLength: 1, maxLength: 120 } } }, output,
      async execute(args, exec) {
        const input = parameters(args, ['op', 'label'])
        if (input.op !== 'create' && input.op !== 'list' || input.op === 'list' && input.label !== undefined) throw new ComputerError('INVALID_REQUEST', '任务操作参数无效')
        assertTaskCaller(exec); session(exec)
        const chat = requireIdentity(options.sessionId?.(exec) ?? exec.agent?.id, '聊天')
        if (input.op === 'create') {
          const label = taskLabel(input.label), taskId = requireIdentity(options.tasks!.createTask(chat, label), '电脑任务')
          exec.signal.throwIfAborted(); assertTaskCaller(exec)
          options.tasks!.resolveTask(chat, taskId)
          return { chatSessionId: chat, taskId, ...(label === undefined ? {} : { taskLabel: label }) }
        }
        const rows = options.tasks!.listTasks(chat), ids = new Set<string>()
        if (!Array.isArray(rows) || rows.length > 8) throw new ComputerError('TASK_LIMIT', '电脑任务列表无效')
        const tasks = rows.map(row => {
          if (row.chatSessionId !== chat) throw new ComputerError('TASK_NOT_FOUND', '电脑任务归属无效')
          const taskId = requireIdentity(row.taskId, '电脑任务'), label = taskLabel(row.taskLabel)
          if (ids.has(taskId)) throw new ComputerError('TASK_NOT_FOUND', '电脑任务列表无效')
          ids.add(taskId)
          return { chatSessionId: chat, taskId, ...(label === undefined ? {} : { taskLabel: label }) }
        })
        exec.signal.throwIfAborted(); assertTaskCaller(exec)
        return { tasks }
      },
    })] : []),
    ...(options.entry ? [
      register({
        name: 'qiuya_computer_discover', description: 'Discover application names in this chat’s current computer environment, including installed applications when supported. Returns short-lived candidate IDs and permission preflight only, without screenshots or window contents. Call this first when the user asks to operate an application. No control or grant is acquired.', parameters: { type: 'object', additionalProperties: false, properties: { taskId: taskParameter, query: { type: 'string', maxLength: 160, description: 'Application name to search, such as Chrome or 微信. Filter is applied before result limits.' }, kind: { type: 'string', enum: ['all', 'application', 'browser'] } } }, output,
        async execute(args, exec) { return entryRun(exec, () => { const input = parameters(args, ['taskId', 'query', 'kind']), binding = bindSession(exec, input); return options.entry!.discover(operationExecution(exec, binding.id), { query: input.query, kind: input.kind } as { query?: string; kind?: 'all' | 'application' | 'browser' }).then(result => { binding.assertCurrent(); return taskResult(result, binding.taskId) }) }) },
      }),
      register({
        name: 'qiuya_computer_request_control', description: 'Request control of a discovered application for this chat. Supply its candidateId and a short explanation of the user’s task. The owner chooses allow once, always allow, or deny in the UI; this tool waits for that decision. Existing owner grants may start directly. Cannot self-authorize, resume a paused/human-controlled session, choose another chat, or alter OS permissions.',
        parameters: { type: 'object', additionalProperties: false, required: ['candidateId', 'reason'], properties: { taskId: taskParameter, candidateId: { type: 'string' }, reason: { type: 'string', maxLength: 600 } } }, output,
        async execute(args, exec) { return entryRun(exec, async () => { const input = parameters(args, ['taskId', 'candidateId', 'reason']), binding = bindSession(exec, input); const result = await options.entry!.requestControl(operationExecution(exec, binding.id), requireIdentity(input.candidateId, '应用候选'), input.reason as string); binding.assertCurrent(); if (binding.isDefault) options.onSelected?.(exec); return JSON.parse(JSON.stringify(taskResult(result, binding.taskId))) }) },
      }),
    ] : []),
    register({
      name: 'qiuya_computer_targets', description: 'List windows only in applications already authorized by the owner. Requires an active computer session; does not grant access.', parameters: noParameters, output,
      async execute(args, exec) { const input = parameters(args, ['taskId']), binding = bindSession(exec, input); const targets = await service.permittedTargets(binding.id, exec.signal); binding.assertCurrent(); return taskResult({ targets }, binding.taskId) },
    }),
    register({
      name: 'qiuya_computer_select', description: 'Switch the active computer session to an already-authorized application window. Cannot resume a paused or human-controlled session and cannot grant new application access.',
      parameters: { type: 'object', additionalProperties: false, required: ['targetId'], properties: { taskId: taskParameter, targetId: { type: 'string' } } }, output,
      async execute(args, exec) { const input = parameters(args, ['taskId', 'targetId']), binding = bindSession(exec, input); const result = await service.selectTarget(binding.id, requireIdentity(input.targetId, '目标'), exec.signal); binding.assertCurrent(); if (binding.isDefault) options.onSelected?.(exec); return JSON.parse(JSON.stringify(taskResult(result, binding.taskId))) },
    }),
    register({
      name: 'qiuya_computer_status', description: 'Read this chat’s computer-control session. When idle, discover applications and request control; application authorization remains an owner decision.', parameters: noParameters, output,
      async execute(args, exec) {
        const input = parameters(args, ['taskId']), binding = bindSession(exec, input), id = binding.id
        const value = JSON.parse(JSON.stringify(service.get(id) ?? { sessionId: id, state: 'idle' }))
        if (value.error) { const error = publicToolError(value.error); value.error = { code: error.code, message: error.message } }
        binding.assertCurrent(); return taskResult(value, binding.taskId)
      },
    }),
    register({
      name: 'qiuya_computer_observe', description: 'Capture the authorized target application and read its accessibility text. The returned frameId is single-use: every successful act, including click/type/key/move, consumes it. Observe again before the next act, even when the window looks unchanged. Do not repeat a completed action to refresh its frame. Coordinates refer to original screenshot pixels.', parameters: noParameters,
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['targetId', 'frameId', 'width', 'height', 'elements', 'image'], properties: { targetId: { type: 'string' }, frameId: { type: 'string', description: 'Single-use observation frame for the next act. Every successful act consumes it; observe again before another act.' }, width: { type: 'integer' }, height: { type: 'integer' }, elements: { type: 'string' }, image: { type: 'object', additionalProperties: true } } },
        render(_args, value) {
          const result = value as unknown as { image: ComputerImageAttachmentRef; frameId: string; width: number; height: number; elements: string; targetId: string; taskId?: string; acceptance?: unknown }
          return [{ type: 'text', text: JSON.stringify({ targetId: result.targetId, frameId: result.frameId, width: result.width, height: result.height, elements: result.elements, ...(result.taskId === undefined ? {} : { taskId: result.taskId }), ...(result.acceptance ? { acceptance: result.acceptance } : {}) }) }, { type: 'image', attachment: result.image }]
        },
      },
      async execute(args, exec) {
        const input = parameters(args, ['taskId']), binding = bindSession(exec, input)
        if (binding.isDefault) options.onSelected?.(exec)
        const observation = await service.observe(binding.id, exec.signal)
        const capturedAt = Date.now()
        binding.assertCurrent()
        const image = await services.attachments.saveImage({ data: Buffer.from(observation.imageBase64, 'base64'), mediaType: observation.mediaType, name: 'computer-observation.jpg' })
        exec.signal.throwIfAborted()
        binding.assertCurrent()
        const acceptance = binding.isDefault ? await options.recorder?.observed(exec, observation, image, capturedAt) : undefined
        exec.signal.throwIfAborted()
        binding.assertCurrent()
        return JSON.parse(JSON.stringify(taskResult({ targetId: observation.targetId, frameId: observation.frameId, width: observation.width, height: observation.height, elements: observation.elements, image, ...(acceptance ? { acceptance } : {}) }, binding.taskId)))
      },
    }),
    register({
      name: 'qiuya_computer_act', description: 'Perform one action in this chat’s authorized application using a fresh frameId from observe. Every successful act, including click/type/key/move, consumes that frameId. Before the next act, observe again and use its new frameId: observe → click → observe → type → observe → key. Do not repeat a completed action to refresh a frame or automatically replay unconfirmed input. Browser mode also supports navigate/openTab(url), selectorClick/selectorType(selector,text), and closeTab within owner-approved origins. These browser actions do not work in native desktop mode. Paused and human-controlled sessions reject Agent input.',
      parameters: { type: 'object', additionalProperties: false, required: ['frameId', 'action'], properties: {
        taskId: taskParameter, actionId: { type: 'string', description: 'Unique action id; reuse only to retrieve the same action result.' }, frameId: { type: 'string', description: 'Fresh frameId from the latest observe, valid for one successful act only. After success, observe again before any next act; never repeat the completed action just to refresh its frame.' },
        action: { type: 'object', required: ['kind'], additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'type', 'key', 'navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'] },
          x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] },
          url: { type: 'string' }, selector: { type: 'string' },
        } },
      } }, output,
      async execute(args, exec) {
        const input = parameters(args, ['taskId', 'actionId', 'frameId', 'action']), binding = bindSession(exec, input), id = binding.id
        const request = { actionId: input.actionId === undefined ? String(exec.callId) : requireIdentity(input.actionId, '操作'), frameId: requireIdentity(input.frameId, '帧'), action: parseComputerAction(input.action) }
        if (binding.isDefault) options.onSelected?.(exec)
        const completed = binding.isDefault ? await options.recorder?.issuing(exec, request) : undefined
        let result: ComputerActionResult
        try { binding.assertCurrent(); result = await service.act(id, request, exec.signal) }
        catch (error) { try { await completed?.(undefined) } catch {} throw error }
        const acceptance = await completed?.(result)
        exec.signal.throwIfAborted()
        binding.assertCurrent()
        return JSON.parse(JSON.stringify(taskResult({ ...result, ...(acceptance ? { acceptance } : {}) }, binding.taskId)))
      },
    }),
    register({
      name: 'qiuya_computer_pause', description: 'Pause this chat’s computer session, cancel pending input and release held keys/buttons. Continuing and granting access remain owner actions in the computer panel.', parameters: noParameters, output,
      async execute(args, exec) { const input = parameters(args, ['taskId']), binding = bindSession(exec, input); const result = await service.pause(binding.id); binding.assertCurrent(); return JSON.parse(JSON.stringify(taskResult(result, binding.taskId))) },
    }),
  ]
  return () => { for (const dispose of unregister.reverse()) dispose() }
}
