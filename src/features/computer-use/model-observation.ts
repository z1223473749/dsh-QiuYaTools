import { ComputerError } from './contract.ts'
import type { ComputerSessionSnapshot } from './contract.ts'
/** Host process lifetime only. No reset/replay, persisted field, renderer input or device request can advance this clock. */
export class ModelObservationClock {
  private issued: number
  constructor(initial = 0) { if (!Number.isSafeInteger(initial) || initial < 0) throw new ComputerError('INVALID_OBSERVATION', '观察序号无效'); this.issued = initial }
  issue(): number { if (this.issued >= Number.MAX_SAFE_INTEGER) throw new ComputerError('INVALID_OBSERVATION', '观察序号已耗尽，请重新打开应用'); return ++this.issued }
  current(): number { return this.issued }
}
interface Receipt { generation: number; epoch: number; targetId: string; frameId: string }
const clock = new ModelObservationClock(), receipts = new WeakMap<object, Map<string, Receipt>>()
/** Called at model observe invocation, before any await, so an older in-flight capture cannot become fresh by completing late. */
export const beginModelObservation = () => clock.issue()
export const currentModelObservationGeneration = () => clock.current()
/** Only the real service's validated successful model capture calls this; raw driver/frame fields are never read as receipts. */
export function commitModelObservation(service: object, chat: string, receipt: Receipt): void {
  if (!Number.isSafeInteger(receipt.generation) || receipt.generation < 1 || receipt.generation > clock.current()) throw new ComputerError('INVALID_OBSERVATION', '观察收据无效')
  let own = receipts.get(service); if (!own) { own = new Map(); receipts.set(service, own) }
  own.set(chat, Object.freeze({ ...receipt }))
}
/** Exact actual service identity and current snapshot are both required. This is a Host-only seam, never a DTO field. */
export function readModelObservationGeneration(service: object, chat: string, snapshot: ComputerSessionSnapshot | undefined): number | undefined {
  const receipt = receipts.get(service)?.get(chat)
  if (!snapshot?.target || !['ready', 'running'].includes(snapshot.state) || !receipt || receipt.epoch !== snapshot.epoch || receipt.targetId !== snapshot.target.id || receipt.targetId !== snapshot.lastObservation?.targetId || receipt.frameId !== snapshot.lastObservation.frameId) return undefined
  return receipt.generation
}
/** Disposing a service retires its receipts without resetting the process-wide issued boundary. */
export function clearModelObservations(service: object): void { receipts.delete(service) }
