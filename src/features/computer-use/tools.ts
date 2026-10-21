import type { Context } from '@deepseek-ai/cordis'
import { ComputerError, parseComputerAction, requireIdentity } from './contract.ts'
import type { ComputerServiceFacade } from './environment-manager.ts'
import type { ComputerPermissionCoordinator } from './permission-coordinator.ts'

// Keep Host-only SDK augmentation out of the shared Client TypeScript graph.
// These structural public seams are verified against the actual SDK in tests.
interface ToolRunContext { callId: string; agent?: { id: string; session?: unknown }; signal: AbortSignal }
interface ImageAttachmentRef { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string; originalDimensions?: { width: number; height: number } }
type Content = { type: 'text'; text: string } | { type: 'image'; attachment: ImageAttachmentRef }
interface ComputerToolDefinition {
  name: string; description: string; parameters: object
  output: { schema: object; render(args: unknown, value: unknown): Content[] }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}
interface ComputerToolServices {
  tools: { register(definition: ComputerToolDefinition): () => void }
  attachments: { saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<ImageAttachmentRef> }
}
export interface ComputerToolsOptions { sessionId?: (exec: ToolRunContext) => string | undefined; enabled?: () => boolean; entry?: ComputerPermissionCoordinator }
const noParameters = { type: 'object', properties: {}, additionalProperties: false }
// The public SDK retains structured codes only for its own HarnessError class;
// PTC forwards just the message. Entry errors use a finite safe vocabulary so
// model and test receipts keep the code without echoing driver paths/secrets.
const entryErrors: Record<string, string> = {
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
async function entryRun<T>(exec: ToolRunContext, run: () => T | Promise<T>): Promise<T> {
  try { return await run() } catch (error) {
    const candidate = exec.signal.aborted ? 'ABORTED' : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
    const code = Object.hasOwn(entryErrors, candidate) ? candidate : 'COMPUTER_ENTRY_FAILED'
    throw new ComputerError(code, `[${code}] ${entryErrors[code]}`)
  }
}
function parameters(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ComputerError('INVALID_REQUEST', '工具参数无效')
  return value as Record<string, unknown>
}
/** Uses only the current Agent's public tool/attachment services; no model requests. */
export function installComputerTools(ctx: Context, service: ComputerServiceFacade, options: ComputerToolsOptions = {}): () => void {
  const services = ctx as Context & ComputerToolServices
  const session = (exec: ToolRunContext): string => {
    if (options.enabled?.() === false) throw new ComputerError('DISABLED', '电脑操控未启用')
    const id = options.sessionId?.(exec) ?? exec.agent?.id
    if (!id) throw new ComputerError('SESSION_REQUIRED', '电脑操控工具必须由当前会话的 Agent 调用')
    return id
  }
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  const register = services.tools.register.bind(services.tools)
  const unregister = [
    ...(options.entry ? [
      register({
        name: 'qiuya_computer_discover', description: 'Discover application names in this chat’s current computer environment, including installed applications when supported. Returns short-lived candidate IDs and permission preflight only, without screenshots or window contents. Call this first when the user asks to operate an application. No control or grant is acquired.', parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', maxLength: 160, description: 'Application name to search, such as Chrome or 微信. Filter is applied before result limits.' }, kind: { type: 'string', enum: ['all', 'application', 'browser'] } } }, output,
        async execute(args, exec) { return entryRun(exec, () => { const input = parameters(args, ['query', 'kind']); session(exec); return options.entry!.discover(exec, input as { query?: string; kind?: 'all' | 'application' | 'browser' }) }) },
      }),
      register({
        name: 'qiuya_computer_request_control', description: 'Request control of a discovered application for this chat. Supply its candidateId and a short explanation of the user’s task. The owner chooses allow once, always allow, or deny in the UI; this tool waits for that decision. Existing owner grants may start directly. Cannot self-authorize, resume a paused/human-controlled session, choose another chat, or alter OS permissions.',
        parameters: { type: 'object', additionalProperties: false, required: ['candidateId', 'reason'], properties: { candidateId: { type: 'string' }, reason: { type: 'string', maxLength: 600 } } }, output,
        async execute(args, exec) { return entryRun(exec, async () => { const input = parameters(args, ['candidateId', 'reason']); session(exec); return JSON.parse(JSON.stringify(await options.entry!.requestControl(exec, requireIdentity(input.candidateId, '应用候选'), input.reason as string))) }) },
      }),
    ] : []),
    register({
      name: 'qiuya_computer_targets', description: 'List windows only in applications already authorized by the owner. Requires an active computer session; does not grant access.', parameters: noParameters, output,
      async execute(args, exec) { parameters(args, []); return { targets: await service.permittedTargets(session(exec), exec.signal) } },
    }),
    register({
      name: 'qiuya_computer_select', description: 'Switch the active computer session to an already-authorized application window. Cannot resume a paused or human-controlled session and cannot grant new application access.',
      parameters: { type: 'object', additionalProperties: false, required: ['targetId'], properties: { targetId: { type: 'string' } } }, output,
      async execute(args, exec) { const input = parameters(args, ['targetId']); return JSON.parse(JSON.stringify(await service.selectTarget(session(exec), requireIdentity(input.targetId, '目标'), exec.signal))) },
    }),
    register({
      name: 'qiuya_computer_status', description: 'Read this chat’s computer-control session. When idle, discover applications and request control; application authorization remains an owner decision.', parameters: noParameters, output,
      async execute(args, exec) { parameters(args, []); const id = session(exec); return JSON.parse(JSON.stringify(service.get(id) ?? { sessionId: id, state: 'idle' })) },
    }),
    register({
      name: 'qiuya_computer_observe', description: 'Capture the authorized target application and read its accessibility text. Use the returned frameId for the next action; coordinates refer to original screenshot pixels.', parameters: noParameters,
      output: {
        schema: { type: 'object', additionalProperties: true, required: ['targetId', 'frameId', 'width', 'height', 'elements', 'image'], properties: { targetId: { type: 'string' }, frameId: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, elements: { type: 'string' }, image: { type: 'object', additionalProperties: true } } },
        render(_args, value) {
          const result = value as unknown as { image: ImageAttachmentRef; frameId: string; width: number; height: number; elements: string; targetId: string }
          return [{ type: 'text', text: JSON.stringify({ targetId: result.targetId, frameId: result.frameId, width: result.width, height: result.height, elements: result.elements }) }, { type: 'image', attachment: result.image }]
        },
      },
      async execute(args, exec) {
        parameters(args, [])
        const observation = await service.observe(session(exec), exec.signal)
        exec.signal.throwIfAborted()
        const image = await services.attachments.saveImage({ data: Buffer.from(observation.imageBase64, 'base64'), mediaType: observation.mediaType, name: 'computer-observation.jpg' })
        exec.signal.throwIfAborted()
        return JSON.parse(JSON.stringify({ targetId: observation.targetId, frameId: observation.frameId, width: observation.width, height: observation.height, elements: observation.elements, image }))
      },
    }),
    register({
      name: 'qiuya_computer_act', description: 'Perform one action in this chat’s authorized application using the latest frameId, then observe to verify. Browser mode also supports navigate/openTab(url), selectorClick/selectorType(selector,text), and closeTab within owner-approved origins. These browser actions do not work in native desktop mode. Paused and human-controlled sessions reject Agent input.',
      parameters: { type: 'object', additionalProperties: false, required: ['frameId', 'action'], properties: {
        actionId: { type: 'string', description: 'Unique action id; reuse only to retrieve the same action result.' }, frameId: { type: 'string' },
        action: { type: 'object', required: ['kind'], additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'type', 'key', 'navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'] },
          x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] },
          url: { type: 'string' }, selector: { type: 'string' },
        } },
      } }, output,
      async execute(args, exec) { const input = parameters(args, ['actionId', 'frameId', 'action']); return JSON.parse(JSON.stringify(await service.act(session(exec), { actionId: input.actionId === undefined ? String(exec.callId) : requireIdentity(input.actionId, '操作'), frameId: requireIdentity(input.frameId, '帧'), action: parseComputerAction(input.action) }, exec.signal))) },
    }),
    register({
      name: 'qiuya_computer_pause', description: 'Pause this chat’s computer session, cancel pending input and release held keys/buttons. Continuing and granting access remain owner actions in the computer panel.', parameters: noParameters, output,
      async execute(args, exec) { parameters(args, []); return JSON.parse(JSON.stringify(await service.pause(session(exec)))) },
    }),
  ]
  return () => { for (const dispose of unregister.reverse()) dispose() }
}
