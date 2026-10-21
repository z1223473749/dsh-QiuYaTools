/** Plugin-owned transport. Never accepts arbitrary URLs from the renderer. */
export const SESSION_WINDOW_CHANNEL = '/api'
export const SESSION_WINDOW_STATUS_ENDPOINT = 'qiuya-tools.session-windows.status'
export const SESSION_WINDOW_OPEN_ENDPOINT = 'qiuya-tools.session-windows.open'
export const SESSION_WINDOW_QUERY = 'qiuya-session'
export const SESSION_WINDOW_MENU = 'qiuya-tools-session-window'

export interface WindowPosition { x: number; y: number }
export interface SessionWindowRequest {
  sessionId: string
  source: 'menu' | 'drag'
  /** Drag preparation is optional; existing callers keep the ordinary open behavior. */
  action?: 'open' | 'prepare' | 'cancel'
  position?: WindowPosition
}
export interface SessionWindowStatus {
  available: boolean
  reason?: string
  harnessVersion?: string
  minimumHarnessVersion?: string
  versionSupported?: boolean
}

export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/u.test(value)
}

export function parseWindowRequest(value: unknown): SessionWindowRequest {
  if (value === null || typeof value !== 'object') throw new Error('Invalid session window request')
  const input = value as Partial<SessionWindowRequest>
  if (!validSessionId(input.sessionId) || (input.source !== 'menu' && input.source !== 'drag')) throw new Error('Invalid session window request')
  const action = input.action ?? 'open'
  if (!['open', 'prepare', 'cancel'].includes(action) || (action !== 'open' && input.source !== 'drag')) throw new Error('Invalid session window action')
  const position = input.position
  if (position !== undefined && (typeof position !== 'object' || position === null || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || Math.abs(position.x) > 100_000 || Math.abs(position.y) > 100_000)) throw new Error('Invalid window position')
  return { sessionId: input.sessionId, source: input.source, action, ...(position === undefined ? {} : { position: { x: position.x, y: position.y } }) }
}

export interface DragEndFacts {
  screenX: number; screenY: number; clientX: number; clientY: number
  dataTransfer: { dropEffect: string } | null
}

/** An accepted drop, Escape, and Chromium's empty cancellation position never detach. */
export function isExternalSessionDrop(event: DragEndFacts, state: { cancelled: boolean; dropped: boolean }, viewport: { width: number; height: number }): boolean {
  return !state.cancelled && !state.dropped && event.dataTransfer?.dropEffect === 'none'
    && Number.isFinite(event.screenX) && Number.isFinite(event.screenY)
    && !(event.screenX === 0 && event.screenY === 0)
    && (event.clientX < 0 || event.clientY < 0 || event.clientX >= viewport.width || event.clientY >= viewport.height)
}
