// JSONL transport fixture only. This Node process never invokes native APIs,
// changes the foreground window, sends input or claims Windows acceptance.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
const [journal, gate, fault = 'none'] = process.argv.slice(2)
const id = () => randomBytes(16).toString('hex')
const identity = {
  pid: process.pid, createdAtTicks: '100', executablePath: process.execPath,
  imageSHA256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  parentPid: process.ppid, parentCreatedAtTicks: '50', sessionId: 1,
  desktopSHA256: 'd'.repeat(64), instanceId: id(), architecture: 'arm64',
}
if (fault === 'pid') identity.pid++
if (fault === 'parent') identity.parentPid++
if (fault === 'path') identity.executablePath += '.wrong'
if (fault === 'image') identity.imageSHA256 = 'e'.repeat(64)
let sequence = '0', ticket = null, release = null, controlled = false, epoch = null, succeeded = false
const record = row => appendFileSync(journal, JSON.stringify({ ...row, pid: process.pid }) + '\n')
const reply = (request, result) => process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, result }) + '\n')
const fail = (request, code) => process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: false, error: { code, message: code } }) + '\n')
const status = () => ({ available: true, platform: fault === 'mac' ? 'darwin' : 'win32', protocolVersion: 1,
  capabilities: { foregroundHandoff: fault !== 'legacy' }, foregroundPhysicalSequence: sequence,
  pendingTicket: ticket?.ticketId ?? null, controlled, epoch })
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line); record({ ...request, phase: 'received' })
  switch (request.op) {
    case 'status': return reply(request, status())
    case 'foregroundContext': return reply(request, { identity, physicalSequence: sequence, controlled, release })
    case 'foregroundPrepare': {
      if (ticket) return fail(request, 'foreground-ticket-pending')
      controlled = true
      ticket = { ticketId: id(), identity, epoch: request.epoch, logicalEpoch: request.logicalEpoch,
        targetId: request.targetId, geometrySHA256: 'a'.repeat(64), actionSHA256: request.actionSHA256,
        surfaceGeneration: request.surfaceGeneration, physicalSequence: sequence, expiresAtQpc: '2000' }
      const prepared = ticket
      if (['ticket-action', 'ticket-cancel-failure'].includes(fault)) prepared.actionSHA256 = '0'.repeat(64)
      if (fault === 'ticket-malformed') prepared.ticketId = 'malformed'
      record({ phase: 'prepared', ticketId: prepared.ticketId })
      const finish = () => { record({ phase: 'prepare-ack', ticketId: prepared.ticketId }); reply(request, { ticket: prepared, physicalSequence: sequence }) }
      if (gate !== '-') { const interval = setInterval(() => { if (existsSync(gate)) { clearInterval(interval); finish() } }, 5) } else finish()
      return
    }
    case 'foregroundCancel': {
      if (fault === 'ticket-cancel-failure') return fail(request, 'fixture-exact-cancel-failed')
      const ticketCancelled = Boolean(ticket && request.ticketId === ticket.ticketId)
      const releaseCancelled = Boolean(release && request.releaseTokenId === release.tokenId)
      if (ticketCancelled) ticket = null
      if (releaseCancelled) release = null
      return reply(request, { cancelled: ticketCancelled || releaseCancelled, ticketCancelled, releaseCancelled })
    }
    case 'lease': epoch = request.epoch; succeeded = false; release = null; return reply(request, { epoch })
    case 'act': {
      if (controlled && (!ticket || request.foregroundTicket?.ticketId !== ticket.ticketId)) return fail(request, 'foreground-ticket-required')
      ticket = null; succeeded = true; return reply(request, { performed: true })
    }
    case 'release': {
      if (succeeded) release = { tokenId: id(), identity, epoch: request.epoch, physicalSequence: sequence,
        targetId: 'fixture', expiresAtQpc: '300000' }
      if (release && fault === 'release-malformed') release.targetId = ''
      if (release && fault === 'release-unidentifiable') release.tokenId = 'malformed'
      epoch = null; succeeded = false; return reply(request, { epoch: request.epoch, released: true, foregroundRelease: release })
    }
    case 'testPhysical': sequence = String(BigInt(sequence) + 1n); ticket = null; release = null;
      process.stdout.write(JSON.stringify({ event: 'foregroundContextInvalidated', physicalSequence: sequence }) + '\n'); return reply(request, status())
    case 'closePreview': return reply(request, { closed: true })
    default: return fail(request, 'fixture-operation-unsupported')
  }
})
lines.on('close', () => { record({ phase: 'eof', pendingTicket: ticket?.ticketId ?? null }); process.exit(0) })
