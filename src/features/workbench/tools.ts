import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm/types'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ComputerError, parseComputerAction, requireIdentity } from '../computer-use/contract.ts'
import type { ComputerActionRequest, ComputerActionResult, ComputerObservation } from '../computer-use/contract.ts'
import type { ComputerToolRunContext } from '../computer-use/tools.ts'
import { uuid } from './contract.ts'
import type { BrowserPermissionCoordinator } from './site-permissions.ts'
import type { BrowserWorkbenchRegistry, HostWorkbenchContext } from './browser-registry.ts'

/** Public SDK types without Host-only Context augmentation in the Client graph.
 * tests/types/workbench-tools-sdk.ts proves assignability against the real ToolRuntime. */
export interface BrowserToolDefinition extends ToolSchema {
  output: { schema: { type: 'object'; additionalProperties: boolean }; render(args: unknown, value: JsonValue): ContentBlock[] }
  execute(args: unknown, exec: ComputerToolRunContext): Promise<unknown>
}
export interface BrowserToolServices {
  tools: { register(definition: BrowserToolDefinition): () => void }
  attachments: { saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> }
}
/** Hook receives the exact nonserializable Host context captured before observe/dispatch. */
export interface BrowserToolsRecorder {
  observed(exec: ComputerToolRunContext, context: HostWorkbenchContext, observation: ComputerObservation, image: ImageAttachmentRef, at: number): Promise<unknown>
  issuing(exec: ComputerToolRunContext, context: HostWorkbenchContext, request: Readonly<ComputerActionRequest>): Promise<((result: ComputerActionResult | undefined) => Promise<unknown>) | undefined>
}
function input(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ComputerError('INVALID_REQUEST', '浏览器参数无效。')
  return value as Record<string, unknown>
}
/** Canonical replay receives plain JSON, so rebuild the public opaque id through its real factory. */
function observationContent(value: JsonValue): ContentBlock[] {
  const object = (v: JsonValue): { [key: string]: JsonValue } => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ComputerError('BROWSER_FAILED', '浏览器画面结果无效。')
    return v
  }
  const positive = (v: JsonValue): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ComputerError('BROWSER_FAILED', '浏览器图片引用无效。')
    return v
  }
  const v = object(value), image = object(v.image), mediaType = image.mediaType
  if (typeof image.attachmentId !== 'string' || !image.attachmentId || !['targetId', 'frameId', 'elements'].every(key => typeof v[key] === 'string') || (mediaType !== 'image/jpeg' && mediaType !== 'image/png' && mediaType !== 'image/webp' && mediaType !== 'image/gif')) throw new ComputerError('BROWSER_FAILED', '浏览器图片引用无效。')
  const attachment: ImageAttachmentRef = { attachmentId: AttachmentId(image.attachmentId), mediaType, bytes: positive(image.bytes), width: positive(image.width), height: positive(image.height) }
  if (image.name !== undefined) { if (typeof image.name !== 'string') throw new ComputerError('BROWSER_FAILED', '浏览器图片名称无效。'); attachment.name = image.name }
  if (image.originalDimensions !== undefined) { const dimensions = object(image.originalDimensions); attachment.originalDimensions = { width: positive(dimensions.width), height: positive(dimensions.height) } }
  return [{ type: 'text', text: JSON.stringify({ targetId: v.targetId, frameId: v.frameId, width: positive(v.width), height: positive(v.height), elements: v.elements, ...(v.acceptance ? { acceptance: v.acceptance } : {}) }) }, { type: 'image', attachment }]
}
const known: Record<string, string> = {
  DISABLED: '电脑操控未启用。', CALLER_NOT_LIVE: '当前聊天 Agent 已失效。', REQUEST_CANCELLED: '网站授权已取消。', REQUEST_STALE: '网站请求已失效，请重新请求。', SITE_DENIED: '你已拒绝本次网站访问。', SITE_REVOKED: '网站许可已撤销。', SITE_NOT_ALLOWED: '请先请求这个网站的授权。', OWNER_RESUME_REQUIRED: '浏览器已暂停或由你接管，需要你点击继续。', APPROVAL_DISABLED: '当前聊天禁止新的交互授权。', REQUEST_PENDING: '当前聊天已有待处理的网站授权。', REQUEST_LIMIT: '待处理的网站请求过多。', PROFILE_REQUIRED: '无法保存网站许可，请使用允许一次。', TARGET_NOT_ACTIVE: '请明确选择当前操作的网页并重新观察。', ENVIRONMENT_CHANGED: '浏览器环境已变化，请重新请求。', TARGET_CHANGED: '网页目标已变化，请重新观察。', CONTROL_CHANGED: '控制权已变化，请重新观察，不要重放未确认操作。', STALE_OBSERVATION: '观察帧已使用或过期，请重新观察，不要重放操作。', ACTION_UNCONFIRMED: '操作结果未确认，请不要重放。', INVALID_REQUEST: '浏览器参数无效。', INVALID_SITE: '请输入不含账号密码的 HTTP 或 HTTPS 地址。', INVALID_VIEW: '工作台视图已失效。', CALL_REUSED: '工具调用编号不能用于另一项浏览器请求。', INVALID_DECISION: '网站授权选择无效。', BROWSER_NOT_INSTALLED: '请安装 Chrome 或 Edge 后重新请求。', BROWSER_HISTORY_UNAVAILABLE: '没有可以前往的历史页面。', BROWSER_CLEANUP_FAILED: '浏览器输入或进程退出尚未确认，请停止操作并检查。', BROWSER_DISCONNECTED: '浏览器连接已断开。', BROWSER_FAILED: '浏览器操作未能确认完成，请不要自动重复输入。',
}
function publicFailure(error: unknown, signal: AbortSignal): Error {
  const code = signal.aborted ? 'REQUEST_CANCELLED' : error instanceof ComputerError && Object.hasOwn(known, error.code) ? error.code : 'BROWSER_FAILED'
  return new ComputerError(code, code + ': ' + known[code])
}
/** Real public tools/attachments; no provider wire access, fake Agent, or arbitrary evaluate endpoint. */
export function installBrowserWorkbenchTools(ctx: Context, registry: BrowserWorkbenchRegistry, permissions: BrowserPermissionCoordinator, options: { recorder?: BrowserToolsRecorder; onSelected?(exec: ComputerToolRunContext, context: HostWorkbenchContext): void } = {}): () => void {
  const services = ctx as Context & BrowserToolServices
  const output: BrowserToolDefinition['output'] = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: JsonValue): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] }
  const registered: Array<() => void> = []
  const register = (definition: BrowserToolDefinition) => { const dispose = services.tools.register({ ...definition, async execute(args, exec) { exec.signal.throwIfAborted(); try { return await definition.execute(args, exec) } catch (error) { throw publicFailure(error, exec.signal) } } }); registered.push(dispose); return dispose }
  const cleanup = () => { const failures: unknown[] = []; for (const dispose of registered.splice(0).reverse()) try { dispose() } catch (failure) { failures.push(failure) } if (failures.length) throw new AggregateError(failures, '浏览器工具卸载尚未确认。') }
  const targetFields = { environmentId: { type: 'string', description: 'Host-issued environmentId from browser_open or browser_tabs; never another chat.' }, workbenchTabId: { type: 'string', description: 'Host-issued view id, independent of URL/title/CDP target id.' } }, targetArgs = ['environmentId', 'workbenchTabId']
  const capture = (exec: ComputerToolRunContext, args: Record<string, unknown>) => registry.capture(exec, uuid(args.environmentId), uuid(args.workbenchTabId))
  try { [
    register({ name: 'qiuya_browser_open', description: 'Open a website in this chat’s dedicated isolated Chrome/Edge browser to complete the user’s task. Start here for requests to open/check/use a website. Host asks the owner for this exact origin once/always/deny before browser launch or content capture; no chat association, CDP configuration or native app grant is needed. This does not authorize another origin, native browser control, or resume paused/human control.', parameters: { type: 'object', additionalProperties: false, required: ['url', 'reason'], properties: { url: { type: 'string', maxLength: 8192 }, reason: { type: 'string', maxLength: 600 }, browser: { type: 'string', enum: ['chrome', 'edge'] } } }, output, async execute(args, exec) { const v = input(args, ['url', 'reason', 'browser']); const target = await permissions.request(exec, v as { url: unknown; reason: unknown; browser?: unknown }); const context = registry.capture(exec, target.environmentId, target.workbenchTabId); options.onSelected?.(exec, context); context.assertCurrent(); return target } }),
    register({ name: 'qiuya_browser_tabs', description: 'List only this current root Agent’s dedicated browser views that remain site-authorized. Uses Host environment/view IDs; matching titles are never ownership. Listing/selecting a UI view does not grant access or switch execution targets.', parameters: { type: 'object', additionalProperties: false, properties: {} }, output, async execute(args, exec) { input(args, []); return { tabs: registry.viewsFor(exec) } } }),
    register({ name: 'qiuya_browser_select', description: 'Explicitly select one already-authorized view in this chat’s dedicated browser as the model execution target. Use Host-issued environment/view IDs from browser_tabs. This is separate from focusing a workbench UI tab, cannot grant an origin, and cannot resume paused or human control.', parameters: { type: 'object', additionalProperties: false, required: targetArgs, properties: targetFields }, output, async execute(args, exec) { const v = input(args, targetArgs), target = await registry.select(exec, uuid(v.environmentId), uuid(v.workbenchTabId)), context = registry.capture(exec, target.environmentId, target.workbenchTabId); options.onSelected?.(exec, context); context.assertCurrent(); return target } }),
    register({ name: 'qiuya_browser_observe', description: 'Observe the exact authorized browser environment/view selected for this chat. Returns a real saved image and a single-use frameId. Every successful action consumes its frame; observe again before the next act. Cannot capture revoked sites, another chat, an old Agent, paused control, or an inactive target.', parameters: { type: 'object', additionalProperties: false, required: targetArgs, properties: targetFields }, output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return observationContent(value) } }, async execute(args, exec) { const v = input(args, targetArgs), context = capture(exec, v); options.onSelected?.(exec, context); context.assertCurrent(); const observation = await registry.observe(context), at = Date.now(); context.assertCurrent(); const image = await services.attachments.saveImage({ data: Buffer.from(observation.imageBase64, 'base64'), mediaType: observation.mediaType, name: 'browser-observation.jpg' }); context.assertCurrent(); const acceptance = await options.recorder?.observed(exec, context, observation, image, at); context.assertCurrent(); return { targetId: observation.targetId, frameId: observation.frameId, width: observation.width, height: observation.height, elements: observation.elements, image, ...(acceptance ? { acceptance } : {}) } } }),
    register({ name: 'qiuya_browser_act', description: 'Perform one action against this chat’s exact authorized browser environment/view with its latest single-use observed frameId. Browser navigation supports navigate/openTab/closeTab/goBack/goForward/reload and selectorClick/selectorType; all destinations need exact-origin owner grants. Never replay an unconfirmed click/submit/type or repeat a completed action to refresh a frame. Observe again after success.', parameters: { type: 'object', additionalProperties: false, required: [...targetArgs, 'frameId', 'action'], properties: { ...targetFields, frameId: { type: 'string' }, actionId: { type: 'string' }, action: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { type: 'string', enum: ['click', 'move', 'drag', 'scroll', 'type', 'key', 'navigate', 'openTab', 'closeTab', 'goBack', 'goForward', 'reload', 'selectorClick', 'selectorType'] }, x: { type: 'number' }, y: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, text: { type: 'string' }, key: { type: 'string' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, url: { type: 'string' }, selector: { type: 'string' } } } } }, output, async execute(args, exec) { const v = input(args, [...targetArgs, 'frameId', 'actionId', 'action']), context = capture(exec, v), request = { actionId: v.actionId === undefined ? requireIdentity(exec.callId) : requireIdentity(v.actionId), frameId: requireIdentity(v.frameId), action: parseComputerAction(v.action) }; const complete = await options.recorder?.issuing(exec, context, request)
      let completing = false
      try {
        // Once issued, guard rejection and dispatch failure both close the same receipt as unknown.
        context.assertCurrent()
        const result = await registry.act(context, request)
        registry.assertAfter(context)
        completing = true
        const acceptance = await complete?.(result)
        // Navigation may legitimately replace the target. Recheck the exact original service/Agent
        // and the actual current authorized origin, rather than reusing the consumed old frame.
        registry.assertAfter(context)
        if (result.workbench) { const selected = registry.capture(exec, result.workbench.environmentId, result.workbench.workbenchTabId); options.onSelected?.(exec, selected); selected.assertCurrent() }
        return { ...result, ...(acceptance ? { acceptance } : {}) }
      } catch (failure) {
        if (!completing) try { await complete?.(undefined) } catch {}
        // A completion that already began is never replayed after a store/authority failure.
        throw failure
      } } }),
    register({ name: 'qiuya_browser_pause', description: 'Pause this chat’s exact active browser environment/view and wait for owned input release. Does not grant a site, switch tabs, or resume human control.', parameters: { type: 'object', additionalProperties: false, required: targetArgs, properties: targetFields }, output, async execute(args, exec) { const v = input(args, targetArgs); return registry.pause(capture(exec, v)) } }),
  ] } catch (failure) { const failures = [failure]; try { cleanup() } catch (error) { failures.push(error) } throw new AggregateError(failures, '浏览器工具注册未完成。') }
  return cleanup
}
