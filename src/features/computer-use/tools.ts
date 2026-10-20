import type { Context } from '@deepseek-ai/cordis'
import { ComputerError, parseComputerAction, requireIdentity } from './contract.ts'
import type { ComputerSessionService } from './session.ts'

// Keep Host-only SDK augmentation out of the shared Client TypeScript graph.
// These structural public seams are verified against the actual SDK in tests.
interface ToolRunContext { callId: string; agent?: { id: string }; signal: AbortSignal }
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
export interface ComputerToolsOptions { sessionId?: (exec: ToolRunContext) => string | undefined; enabled?: () => boolean }
const noParameters = { type: 'object', properties: {}, additionalProperties: false }
function parameters(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ComputerError('INVALID_REQUEST', '工具参数无效')
  return value as Record<string, unknown>
}
/** Uses only the current Agent's public tool/attachment services; no model requests. */
export function installComputerTools(ctx: Context, service: ComputerSessionService, options: ComputerToolsOptions = {}): () => void {
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
      name: 'qiuya_computer_status', description: 'Read this chat’s computer-control session. The owner must select and authorize an application in the computer panel before use.', parameters: noParameters, output,
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
