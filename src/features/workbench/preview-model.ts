import type { ComputerObservation, ComputerSessionSnapshot } from '../computer-use/contract.ts'
/** Reuses the approved AI arrow metadata; a human pointer is never relabelled as AI. */
export function workbenchCursor(observation: ComputerObservation, snapshot: ComputerSessionSnapshot | undefined): ComputerObservation['aiCursor'] {
  if (!snapshot || !['ready', 'running'].includes(snapshot.state)) return undefined
  const cursor = observation.aiCursor
  if (cursor?.actor === 'ai') return cursor.visible && (cursor.epoch === undefined || cursor.epoch === snapshot.epoch) ? cursor : undefined
  const receipt = snapshot.lastAction, action = receipt?.action
  if (receipt?.actor !== 'ai' || receipt.phase !== 'completed' || !action) return undefined
  const x = action.kind === 'drag' ? action.toX : action.x, y = action.kind === 'drag' ? action.toY : action.y
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= observation.width || y >= observation.height) return undefined
  return { x, y, visible: true, actor: 'ai', epoch: snapshot.epoch, phase: 'completed' }
}
export function framePoint(point: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }, image: { width: number; height: number }, fit: 'fill' | 'contain') {
  if (![point.x, point.y, box.left, box.top, box.width, box.height, image.width, image.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return null
  const scale = Math.min(box.width / image.width, box.height / image.height), width = fit === 'fill' ? box.width : image.width * scale, height = fit === 'fill' ? box.height : image.height * scale, left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2
  if (point.x < left || point.y < top || point.x >= left + width || point.y >= top + height) return null
  return { x: (point.x - left) * image.width / width, y: (point.y - top) * image.height / height }
}
