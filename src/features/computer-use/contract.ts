/** Shared vocabulary for the owner UI, Agent tools and native companions. */
export type ComputerState = 'idle' | 'connecting' | 'awaitingPermission' | 'ready' | 'running' | 'pausing' | 'paused' | 'handingOver' | 'humanControl' | 'resuming' | 'stopping' | 'stopped' | 'disconnected' | 'faulted'
export interface ComputerGeometry { x: number; y: number; width: number; height: number; scale: number }
export interface NativeTarget extends ComputerGeometry { id: string; appId: string; title: string; pid: number }
export interface ComputerObservation {
  targetId: string; frameId: string; imageBase64: string; mediaType: 'image/jpeg'
  width: number; height: number; elements: string; geometry: ComputerGeometry
  cursor?: { x: number; y: number; visible: boolean }
  aiCursor?: { x: number; y: number; visible: boolean; actor: 'ai'; epoch?: number; phase?: string }
}
export interface ComputerAction {
  kind: 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key' | 'navigate' | 'openTab' | 'closeTab' | 'selectorClick' | 'selectorType'
  x?: number; y?: number; toX?: number; toY?: number; text?: string; key?: string
  deltaX?: number; deltaY?: number; button?: 'left' | 'right' | 'middle'
  url?: string; selector?: string
}
export interface ComputerActionRequest { actionId: string; frameId: string; action: ComputerAction }
export interface ComputerActionResult { actionId: string; targetId: string; epoch: number; result: unknown }
export interface ComputerStatus { available: boolean; platform?: string; permissions?: Record<string, boolean>; capabilities?: Record<string, boolean> | string[]; message?: string; [key: string]: unknown }
export interface ComputerSessionSnapshot {
  sessionId: string; state: ComputerState; target: NativeTarget | null; epoch: number; updatedAt: number
  lastObservation?: Omit<ComputerObservation, 'imageBase64' | 'elements' | 'mediaType'>
  error?: { code: string; message: string }
  lastAction?: { actionId: string; action: ComputerAction; actor?: 'ai' | 'human'; phase: 'executing' | 'completed' | 'failed'; at: number }
}
export interface DeviceDriver {
  status(signal?: AbortSignal): Promise<ComputerStatus>
  targets(signal?: AbortSignal): Promise<NativeTarget[]>
  observe(targetId: string, signal?: AbortSignal): Promise<ComputerObservation>
  preview?(targetId: string, signal?: AbortSignal): Promise<ComputerObservation>
  lease(epoch: number, signal?: AbortSignal, options?: { actor: 'ai' | 'human' }): Promise<unknown>
  release(epoch: number, signal?: AbortSignal): Promise<unknown>
  act(epoch: number, targetId: string, action: ComputerAction, signal?: AbortSignal): Promise<unknown>
  resolveActionTarget?(target: NativeTarget, action: ComputerAction, result: unknown, signal?: AbortSignal): Promise<NativeTarget | null>
  openPreview(url: string, title: string, sessionId: string, signal?: AbortSignal): Promise<unknown>
  closePreview(signal?: AbortSignal, options?: { preserveSession?: boolean }): Promise<unknown>
  subscribe?(listener: (event: NativeComputerEvent) => void): () => void
  dispose?(): void | Promise<void>
}
export interface NativeComputerEvent { event: string; sessionId?: string; [key: string]: unknown }
export class ComputerError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ComputerError' }
}
export function computerError(error: unknown): { code: string; message: string } {
  return error instanceof ComputerError ? { code: error.code, message: error.message } : { code: 'COMPUTER_FAILED', message: error instanceof Error ? error.message : '电脑操控失败' }
}
export function requireIdentity(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\x00-\x1f\x7f]/u.test(value)) throw new ComputerError('INVALID_REQUEST', `${label} 无效`)
  return value
}
export function sameGeometry(a: ComputerGeometry, b: ComputerGeometry): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.scale === b.scale
}
export function validGeometry(value: ComputerGeometry): boolean {
  return [value?.x, value?.y, value?.width, value?.height, value?.scale].every(Number.isFinite) && value.width > 0 && value.height > 0 && value.scale > 0
}
/** Reject unexpected fields so a renderer/model cannot smuggle native options. */
export function parseComputerAction(value: unknown): ComputerAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputerError('INVALID_ACTION', '操作必须是对象')
  const input = value as Record<string, unknown>
  const fields = new Set(['kind', 'x', 'y', 'toX', 'toY', 'text', 'key', 'deltaX', 'deltaY', 'button', 'url', 'selector'])
  if (Object.keys(input).some(key => !fields.has(key))) throw new ComputerError('INVALID_ACTION', '操作包含不支持的参数')
  if (!['click', 'move', 'drag', 'scroll', 'type', 'key', 'navigate', 'openTab', 'closeTab', 'selectorClick', 'selectorType'].includes(String(input.kind))) throw new ComputerError('INVALID_ACTION', '不支持的操作')
  for (const field of ['x', 'y', 'toX', 'toY', 'deltaX', 'deltaY']) if (input[field] !== undefined && (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || Math.abs(input[field] as number) > 1_000_000)) throw new ComputerError('INVALID_ACTION', `${field} 无效`)
  if (input.button !== undefined && !['left', 'right', 'middle'].includes(String(input.button))) throw new ComputerError('INVALID_ACTION', '鼠标按键无效')
  if (['click', 'move', 'drag', 'scroll'].includes(String(input.kind)) && (input.x === undefined || input.y === undefined)) throw new ComputerError('INVALID_ACTION', '操作需要 x 和 y')
  if (input.kind === 'drag' && (input.toX === undefined || input.toY === undefined)) throw new ComputerError('INVALID_ACTION', '拖动需要终点')
  if (input.kind === 'scroll' && input.deltaX === undefined && input.deltaY === undefined) throw new ComputerError('INVALID_ACTION', '滚动需要距离')
  if (['type', 'selectorType'].includes(String(input.kind)) && (typeof input.text !== 'string' || input.text.length > 100_000 || input.text.includes('\0'))) throw new ComputerError('INVALID_ACTION', '输入文本无效')
  if (input.kind === 'key' && (typeof input.key !== 'string' || input.key.length === 0 || input.key.length > 128 || /[\x00-\x1f\x7f]/u.test(input.key))) throw new ComputerError('INVALID_ACTION', '按键无效')
  if (['navigate', 'openTab'].includes(String(input.kind))) {
    if (typeof input.url !== 'string' || input.url.length > 8192) throw new ComputerError('INVALID_ACTION', '页面地址无效')
    try { const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error() } catch { throw new ComputerError('INVALID_ACTION', '页面地址必须是无嵌入凭据的 HTTP 或 HTTPS 地址') }
  }
  if (['selectorClick', 'selectorType'].includes(String(input.kind)) && (typeof input.selector !== 'string' || !input.selector || input.selector.length > 2048 || /[\x00-\x1f\x7f]/u.test(input.selector))) throw new ComputerError('INVALID_SELECTOR', 'CSS 选择器无效')
  if (input.selector !== undefined && !['selectorClick', 'selectorType'].includes(String(input.kind))) throw new ComputerError('INVALID_ACTION', '请使用浏览器专用的选择器操作')
  if (input.url !== undefined && !['navigate', 'openTab'].includes(String(input.kind))) throw new ComputerError('INVALID_ACTION', '页面地址只适用于导航或新标签页')
  return { ...input } as unknown as ComputerAction
}
export function checkActionBounds(action: ComputerAction, observation: Pick<ComputerObservation, 'width' | 'height'>): void {
  for (const [x, y] of [[action.x, action.y], [action.toX, action.toY]]) {
    if (x === undefined && y === undefined) continue
    if (x === undefined || y === undefined || x < 0 || y < 0 || x >= observation.width || y >= observation.height) throw new ComputerError('OUT_OF_BOUNDS', '操作坐标超出当前截图')
  }
}
