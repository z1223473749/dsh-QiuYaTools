import { createHash } from 'node:crypto'
import { ComputerError } from './contract.ts'
import type { ComputerAction, ForegroundActionTicket, ForegroundContext, ForegroundGrantReceipt, ForegroundReleaseToken, ForegroundWorkerIdentity } from './contract.ts'

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器返回了无效状态')
  return value as Record<string, unknown>
}
const text = (value: unknown, pattern: RegExp): string => { if (typeof value !== 'string' || !pattern.test(value)) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器身份无效'); return value }
const integer = (value: unknown, minimum = 0): number => { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器周期无效'); return value as number }
const decimal = /^\d{1,20}$/u, guid = /^[a-f0-9]{32}$/iu, digest = /^[a-f0-9]{64}$/u
const identifier = /^[^\x00-\x1f\x7f]{1,512}$/u
export function foregroundActionSHA256(action: ComputerAction): string { return createHash('sha256').update(JSON.stringify(action), 'utf8').digest('hex') }
export function foregroundIdentity(value: unknown): ForegroundWorkerIdentity {
  const v = record(value), architecture = v.architecture
  if (!['arm64', 'x64'].includes(String(architecture))) throw new ComputerError('NATIVE_PROTOCOL', '前台交接执行器架构无效')
  return { pid: integer(v.pid, 1), createdAtTicks: text(v.createdAtTicks, decimal), executablePath: text(v.executablePath, /^[^\x00-\x1f\x7f]{1,32768}$/u), imageSHA256: text(v.imageSHA256, digest),
    parentPid: integer(v.parentPid, 1), parentCreatedAtTicks: text(v.parentCreatedAtTicks, decimal), sessionId: integer(v.sessionId, 1), desktopSHA256: text(v.desktopSHA256, digest), instanceId: text(v.instanceId, guid), architecture: architecture as 'arm64' | 'x64' }
}
export function sameForegroundIdentity(a: ForegroundWorkerIdentity, b: ForegroundWorkerIdentity): boolean {
  return a.pid === b.pid && a.createdAtTicks === b.createdAtTicks && a.executablePath.toLowerCase() === b.executablePath.toLowerCase() && a.imageSHA256 === b.imageSHA256 && a.parentPid === b.parentPid && a.parentCreatedAtTicks === b.parentCreatedAtTicks && a.sessionId === b.sessionId && a.desktopSHA256 === b.desktopSHA256 && a.instanceId === b.instanceId && a.architecture === b.architecture
}
export function foregroundSiblings(a: ForegroundWorkerIdentity, b: ForegroundWorkerIdentity): boolean {
  return a.pid !== b.pid && a.instanceId !== b.instanceId && a.executablePath.toLowerCase() === b.executablePath.toLowerCase() && a.imageSHA256 === b.imageSHA256 && a.parentPid === b.parentPid && a.parentCreatedAtTicks === b.parentCreatedAtTicks && a.sessionId === b.sessionId && a.desktopSHA256 === b.desktopSHA256 && a.architecture === b.architecture
}
export function foregroundRelease(value: unknown): ForegroundReleaseToken {
  const v = record(value)
  return { tokenId: text(v.tokenId, guid), identity: foregroundIdentity(v.identity), epoch: integer(v.epoch, 1), physicalSequence: text(v.physicalSequence, decimal), targetId: text(v.targetId, identifier), expiresAtQpc: text(v.expiresAtQpc, decimal) }
}
export function foregroundContext(value: unknown): ForegroundContext {
  const v = record(value)
  if (typeof v.controlled !== 'boolean') throw new ComputerError('NATIVE_PROTOCOL', '前台交接控制状态无效')
  const result = { identity: foregroundIdentity(v.identity), physicalSequence: text(v.physicalSequence, decimal), controlled: v.controlled, ...(v.release ? { release: foregroundRelease(v.release) } : {}) }
  if (result.release && (!sameForegroundIdentity(result.identity, result.release.identity) || result.release.physicalSequence !== result.physicalSequence)) throw new ComputerError('CONTROL_CHANGED', '前台交接的物理输入状态已变化')
  return result
}
export function foregroundTicket(value: unknown): ForegroundActionTicket {
  const v = record(value)
  return { ticketId: text(v.ticketId, guid), identity: foregroundIdentity(v.identity), epoch: integer(v.epoch, 1), logicalEpoch: integer(v.logicalEpoch), targetId: text(v.targetId, identifier), geometrySHA256: text(v.geometrySHA256, digest), actionSHA256: text(v.actionSHA256, digest), surfaceGeneration: integer(v.surfaceGeneration, 1), physicalSequence: text(v.physicalSequence, decimal), expiresAtQpc: text(v.expiresAtQpc, decimal) }
}
export function foregroundGrant(value: unknown): ForegroundGrantReceipt {
  const v = record(value)
  if (typeof v.attempted !== 'boolean' || typeof v.allowed !== 'boolean' || !Number.isSafeInteger(v.error) || (v.error as number) < 0 || (v.error as number) > 2147483647) throw new ComputerError('NATIVE_PROTOCOL', '前台交接回执无效')
  return { attempted: v.attempted, allowed: v.allowed, error: v.error as number, donor: foregroundIdentity(v.donor), recipient: foregroundIdentity(v.recipient), ticketId: text(v.ticketId, guid), releaseTokenId: text(v.releaseTokenId, guid), physicalSequence: text(v.physicalSequence, decimal) }
}
