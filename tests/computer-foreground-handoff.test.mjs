import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const code = (await build({ stdin: { contents: "export * from './src/features/computer-use/scheduled-driver.ts';export * from './src/features/computer-use/contract.ts';export * from './src/features/computer-use/foreground-handoff.ts'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { ComputerInputScheduler, ScheduledComputerDriver, ComputerActionCleanupError, foregroundActionSHA256, foregroundIdentity, foregroundContext, foregroundTicket, foregroundGrant, foregroundSiblings } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const tick = () => new Promise(done => setImmediate(done)), deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let serial = 0
const id = () => (++serial).toString(16).padStart(32, '0')
function create(label, scheduler, order, { surface = 'local-desktop', enabled = true, identityPatch = {}, clock = { now: 0 } } = {}) {
  const identity = { pid: label === 'A' ? 101 : 102, createdAtTicks: label === 'A' ? '10001' : '10002', executablePath: 'C:\\own\\qiuya-windows.exe', imageSHA256: 'a'.repeat(64), parentPid: 90, parentCreatedAtTicks: '9000', sessionId: 1, desktopSHA256: 'b'.repeat(64), architecture: 'arm64', instanceId: id(), ...identityPatch }
  const state = { sequence: '0', controlled: false, token: null, ticket: null, epoch: null, act: 0, prepare: 0, grant: 0, release: 0, context: 0, cancel: 0, denied: false }, listeners = new Set()
  const foreground = {
    get physicalSequence() { return state.sequence },
    async context(signal) { signal?.throwIfAborted(); if (state.token && Number(state.token.expiresAtQpc) <= clock.now) state.token = null; state.context++; order.push(label + '-context'); return structuredClone({ identity, physicalSequence: state.sequence, controlled: state.controlled, release: state.token }) },
    async prepare(input, signal) { signal?.throwIfAborted(); state.prepare++; state.controlled = true; order.push(label + '-prepare'); const ticket = { ticketId: id(), identity, ...input, geometrySHA256: 'c'.repeat(64), physicalSequence: state.sequence, expiresAtQpc: '99999999999999999' }; state.ticket = structuredClone(ticket); return structuredClone({ ticket, physicalSequence: state.sequence }) },
    async grant(input, signal) { signal?.throwIfAborted(); state.grant++; order.push(label + '-grant'); assert.equal(state.epoch, null); assert.equal(input.releaseToken.tokenId, state.token.tokenId); state.token = null; return structuredClone({ attempted: true, allowed: !state.denied, error: state.denied ? 5 : 0, donor: identity, recipient: input.recipient, ticketId: input.ticket.ticketId, releaseTokenId: input.releaseToken.tokenId, physicalSequence: state.sequence }) },
    async cancel(input) { state.cancel++; order.push(label + '-cancel'); let cancelled = false; if (state.ticket?.ticketId === input.ticketId) { state.ticket = null; cancelled = true }; if (state.token?.tokenId === input.releaseTokenId) { state.token = null; cancelled = true }; return { cancelled } },
  }
  const inner = {
    ...(enabled ? { foregroundHandoff: foreground } : {}),
    async status() { return { available: true, platform: enabled ? 'win32' : 'darwin' } }, async targets() { return [] }, async observe() { return {} },
    async lease(epoch, signal, options) { signal?.throwIfAborted(); order.push(label + '-lease'); state.epoch = epoch; state.actor = options.actor },
    async act(epoch, targetId, action, signal, privateOptions) { signal?.throwIfAborted(); state.act++; order.push(label + '-act'); assert.equal(state.epoch, epoch); if (state.controlled) { assert.equal(privateOptions.foregroundTicket.ticketId, state.ticket.ticketId); assert.equal(privateOptions.foregroundTicket.targetId, targetId); assert.equal(privateOptions.foregroundTicket.actionSHA256, foregroundActionSHA256(action)); state.ticket = null }; return { performed: true } },
    async release(epoch) { state.release++; order.push(label + '-release'); state.epoch = null; if (state.act) state.token = { tokenId: id(), identity, epoch, physicalSequence: state.sequence, targetId: label, expiresAtQpc: String(clock.now + 300_000) }; return { epoch, released: true, ...(enabled ? { foregroundRelease: structuredClone(state.token) } : {}) } },
    async openPreview() {}, async closePreview() {}, async dispose() { order.push(label + '-dispose') }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
  const driver = new ScheduledComputerDriver(inner, surface, scheduler)
  return { driver, inner, foreground, identity, state, emit(event) { for (const fn of listeners) fn(event) }, physical() { state.sequence = String(BigInt(state.sequence) + 1n); state.token = null; state.ticket = null; for (const fn of listeners) fn({ event: 'foregroundContextInvalidated', physicalSequence: state.sequence, identity }) } }
}
const move = { kind: 'move', x: 2, y: 3 }, act = fixture => fixture.driver.act(1, fixture.identity.pid === 101 ? 'A' : 'B', move)
async function pair() { const scheduler = new ComputerInputScheduler(), order = [], a = create('A', scheduler, order), b = create('B', scheduler, order); await a.driver.lease(1); await b.driver.lease(1); return { scheduler, order, a, b } }
async function close(...items) { await Promise.all(items.map(f => f.driver.dispose())) }

test('real FIFO contract hands off once after A clean release, and every later B action has a new ticket without another grant', async () => {
  const { a, b, order } = await pair(); await act(a); await act(b); await act(b)
  assert.equal(a.state.grant, 1); assert.equal(b.state.grant, 0); assert.equal(a.state.act, 1); assert.equal(b.state.act, 2); assert.equal(b.state.prepare, 2)
  assert.ok(order.indexOf('A-release') < order.indexOf('A-grant')); assert.ok(order.indexOf('A-grant') < order.indexOf('B-lease')); assert.ok(order.indexOf('B-lease') < order.indexOf('B-act')); await close(a, b)
})
test('old helper, Mac and nonlocal surface retain the old action path without foreground RPC', async () => {
  for (const options of [{ enabled: false }, { surface: 'remote:own' }, { surface: 'browser:own' }]) {
    const order = [], f = create('A', new ComputerInputScheduler(), order, options); await f.driver.lease(1); await act(f)
    assert.equal(f.state.context, 0); assert.equal(f.state.prepare, 0); assert.equal(f.state.grant, 0); assert.equal(f.state.act, 1); await close(f)
  }
})
test('different managers never discover or grant to each other', async () => {
  const order = [], a = create('A', new ComputerInputScheduler(), order), b = create('B', new ComputerInputScheduler(), order); await a.driver.lease(1); await b.driver.lease(1); await act(a); await act(b); assert.equal(a.state.grant + b.state.grant, 0); await close(a, b)
})
test('ASFW false is not activation: B receives no lease or act and the original action is not retried', async () => {
  const { a, b, order } = await pair(); await act(a); a.state.denied = true
  await assert.rejects(act(b), { code: 'FOREGROUND_HANDOFF_DENIED' }); assert.equal(a.state.grant, 1); assert.equal(b.state.act, 0); assert.equal(order.includes('B-lease'), false); assert.equal(b.state.ticket, null); await close(a, b)
})
test('a grant exception is not retried and cannot dispatch B', async () => {
  const { a, b } = await pair(); await act(a); let calls = 0; a.foreground.grant = async () => { calls++; throw Object.assign(Error('native grant failed'), { code: 'foreground-grant-failed' }) }
  await assert.rejects(act(b), /native grant failed/u); assert.equal(calls, 1); assert.equal(b.state.act, 0); assert.equal(b.state.epoch, null); await close(a, b)
})
for (const [name, identityPatch] of Object.entries({ image: { imageSHA256: 'f'.repeat(64) }, architecture: { architecture: 'x64' }, parent: { parentPid: 91 }, parentBirth: { parentCreatedAtTicks: '9001' }, session: { sessionId: 2 }, desktop: { desktopSHA256: 'f'.repeat(64) } })) test('a different ' + name + ' cannot receive a grant', async () => {
  const order = [], scheduler = new ComputerInputScheduler(), a = create('A', scheduler, order), b = create('B', scheduler, order, { identityPatch }); await a.driver.lease(1); await b.driver.lease(1); await act(a)
  await assert.rejects(act(b), { code: 'CONTROL_CHANGED' }); assert.equal(a.state.grant, 0); assert.equal(b.state.act, 0); await close(a, b)
})
test('A pause before grant commit cancels the pending handoff, even when the native grant itself already succeeded', async () => {
  const { a, b } = await pair(); await act(a); const grant = a.foreground.grant
  a.foreground.grant = async (...args) => { const reply = await grant(...args); await a.driver.release(1); return reply }
  await assert.rejects(act(b), { code: 'FOREGROUND_HANDOFF_DENIED' }); assert.equal(a.state.grant, 1); assert.equal(b.state.act, 0); assert.equal(b.state.ticket, null); await close(a, b)
})
test('A pause or close after B commit cannot cancel the committed B action', async () => {
  const { a, b } = await pair(); await act(a); const original = b.inner.act
  b.inner.act = async (...args) => { await a.driver.release(1); a.emit({ event: 'previewClosed' }); return original(...args) }
  await act(b); assert.equal(b.state.act, 1); assert.equal(b.state.epoch, null); await close(a, b)
})
test('B own pause during prepare cancels its exact ticket before any physical lease', async () => {
  const { a, b, order } = await pair(); const prepare = b.foreground.prepare
  b.foreground.prepare = async (...args) => { const reply = await prepare(...args); await b.driver.release(1); return reply }
  await assert.rejects(act(b), { code: 'CONTROL_CHANGED' }); assert.equal(b.state.act, 0); assert.equal(order.includes('B-lease'), false); assert.equal(b.state.ticket, null); await close(a, b)
})
test('physical intervention in the idle grant gap invalidates queued generation and pending ticket without replay', async () => {
  const { a, b } = await pair(); await act(a); const grant = a.foreground.grant
  a.foreground.grant = async (...args) => { const reply = await grant(...args); a.physical(); b.physical(); return reply }
  await assert.rejects(act(b), { code: 'CONTROL_CHANGED' }); assert.equal(a.state.grant, 1); assert.equal(b.state.act, 0); assert.equal(b.state.ticket, null); await close(a, b)
})
test('idle physical sequence is also compared at enqueue rather than trusting an eventual event', async () => {
  const { a, b } = await pair(); const gate = deferred(), original = a.inner.act
  a.inner.act = async (...args) => { await gate.promise; return original(...args) }; const pa = act(a); await tick(); const pb = act(b), rejected = assert.rejects(pb, { code: 'CONTROL_CHANGED' })
  b.state.sequence = '1'; gate.resolve(); await pa; await rejected; assert.equal(b.state.prepare, 0); assert.equal(b.state.act, 0); await close(a, b)
})
test('an exact worker instance change after prepare cannot acquire a physical lease', async () => {
  const { a, b } = await pair(); const prepare = b.foreground.prepare
  b.foreground.prepare = async (...args) => { const reply = await prepare(...args); reply.ticket.identity.instanceId = id(); return reply }
  await assert.rejects(act(b), { code: 'CONTROL_CHANGED' }); assert.equal(b.state.act, 0); await close(a, b)
})
test('the original action error and failed release remain separate, and neither can create a donor', async () => {
  const { a, b, scheduler } = await pair(), primary = Error('original act'), cleanup = Error('release uncertain')
  a.inner.act = async () => { throw primary }; const release = a.inner.release; let fail = true
  a.inner.release = async (...args) => { if (fail) throw cleanup; return release(...args) }
  await assert.rejects(act(a), error => error instanceof ComputerActionCleanupError && error.code === 'INPUT_CLEANUP_FAILED' && error.actionError === primary && error.cleanupErrors[0] === cleanup)
  assert.equal(scheduler.foregroundDonor('local-desktop'), undefined); fail = false; await close(a, b)
})
test('human actor and logical zero are preserved while each controlled action still gets a ticket', async () => {
  const f = create('A', new ComputerInputScheduler(), []); await f.driver.lease(0, undefined, { actor: 'human' }); await f.driver.act(0, 'A', move); assert.equal(f.state.actor, 'human'); assert.equal(f.state.prepare, 1); assert.equal(f.state.act, 1); await close(f)
})
test('private wire validators strip payloads and reject malformed identities, tickets and grant receipts', () => {
  const f = create('A', new ComputerInputScheduler(), []), identity = f.identity
  assert.deepEqual(foregroundIdentity({ ...identity, secret: 'PRIVATE' }), identity)
  assert.throws(() => foregroundIdentity({ ...identity, instanceId: 'bad' }), { code: 'NATIVE_PROTOCOL' })
  assert.throws(() => foregroundContext({ identity, physicalSequence: '2', controlled: true, release: { tokenId: id(), identity, epoch: 1, physicalSequence: '1', targetId: 'A', expiresAtQpc: '1' } }), { code: 'CONTROL_CHANGED' })
  assert.throws(() => foregroundTicket({}), { code: 'NATIVE_PROTOCOL' }); assert.throws(() => foregroundGrant({ attempted: true, allowed: true, error: -1 }), { code: 'NATIVE_PROTOCOL' })
  assert.equal(foregroundSiblings(identity, { ...identity }), false)
})

test('a 95-second model gap keeps an unconsumed donor while B receives a fresh two-second ticket', async () => {
  const clock = { now: 0 }, order = [], scheduler = new ComputerInputScheduler(), a = create('A', scheduler, order, { clock }), b = create('B', scheduler, order, { clock })
  await a.driver.lease(1); await b.driver.lease(1); await act(a); const tokenId = a.state.token.tokenId
  clock.now = 95_000; await act(b)
  assert.equal(a.state.grant, 1); assert.equal(b.state.prepare, 1); assert.equal(b.state.act, 1)
  assert.notEqual(b.state.token.tokenId, tokenId); await close(a, b)
})
test('a donor beyond the 300-second bound cannot grant or dispatch B and is never renewed by replaying A', async () => {
  const clock = { now: 0 }, order = [], scheduler = new ComputerInputScheduler(), a = create('A', scheduler, order, { clock }), b = create('B', scheduler, order, { clock })
  await a.driver.lease(1); await b.driver.lease(1); await act(a); clock.now = 300_001
  await assert.rejects(act(b), { code: 'CONTROL_CHANGED' })
  assert.equal(a.state.act, 1); assert.equal(a.state.grant, 0); assert.equal(b.state.act, 0); assert.equal(b.state.ticket, null)
  assert.ok(!order.includes('B-lease')); await close(a, b)
})
test('physical input while release cleanup awaits cannot republish a stale donor', async () => {
  const { a, b, scheduler } = await pair(), cancel = a.foreground.cancel; let interrupted = false
  a.foreground.cancel = async input => { const reply = await cancel(input); if (input.ticketId && !interrupted) { interrupted = true; a.physical(); b.physical() }; return reply }
  await act(a); assert.equal(scheduler.foregroundDonor('local-desktop'), undefined); assert.equal(a.state.token, null)
  await act(b); assert.equal(a.state.grant, 0); assert.equal(b.state.act, 1); await close(a, b)
})
test('a successful release token after an uncertain action reply is cancelled even when the original action error must win', async () => {
  const { a, b, scheduler } = await pair(), actual = a.inner.act, primary = Error('act reply cancelled')
  a.inner.act = async (...args) => { await actual(...args); throw primary }
  await assert.rejects(act(a), error => error === primary)
  assert.equal(a.state.act, 1); assert.equal(a.state.token, null); assert.equal(scheduler.foregroundDonor('local-desktop'), undefined)
  await close(a, b)
})
test('token cancellation failure after a failed action preserves both failure layers', async () => {
  const { a, b } = await pair(), actual = a.inner.act, cancel = a.foreground.cancel, primary = Error('cancelled action ACK'), cleanup = Error('token cleanup failed')
  a.inner.act = async (...args) => { await actual(...args); throw primary }
  a.foreground.cancel = async input => { if (input.releaseTokenId) throw cleanup; return cancel(input) }
  await assert.rejects(act(a), error => error instanceof ComputerActionCleanupError && error.actionError === primary && error.cleanupErrors[0] === cleanup)
  a.foreground.cancel = cancel; await close(a, b)
})

for (const mode of ['denied', 'exception-after-consumed']) test('a ' + mode + ' grant retires only the consumed donor and a later fresh action never reuses it', async () => {
  const { a, b, scheduler } = await pair(); await act(a); const grant = a.foreground.grant, tokenId = a.state.token.tokenId
  if (mode === 'denied') a.state.denied = true
  else a.foreground.grant = async (...args) => { await grant(...args); throw Error('grant ACK lost after consumed') }
  await assert.rejects(act(b)); assert.equal(a.state.grant, 1); assert.equal(a.state.token, null)
  assert.equal(scheduler.foregroundDonor('local-desktop'), undefined); assert.equal(b.state.act, 0)
  a.state.denied = false; a.foreground.grant = grant
  await act(b); assert.equal(a.state.grant, 1); assert.equal(b.state.act, 1); assert.equal(b.state.prepare, 2)
  assert.notEqual(b.state.token.tokenId, tokenId); await close(a, b)
})
test('failed grant does not erase a different donor published by a concurrent lifecycle event', async () => {
  const { a, b, scheduler } = await pair(); await act(a); const previous = scheduler.foregroundDonor('local-desktop')
  const successor = { ...previous, owner: {}, revoked: false }
  a.foreground.grant = async () => { scheduler.rememberForeground('local-desktop', successor); throw Error('grant failed') }
  await assert.rejects(act(b), /grant failed/u); assert.equal(scheduler.foregroundDonor('local-desktop'), successor)
  scheduler.clearForeground('local-desktop'); await close(a, b)
})
test('a denied grant and failed exact donor cancellation preserve both errors without dispatching B', async () => {
  const { a, b, scheduler } = await pair(); await act(a); a.state.denied = true
  const cancel = a.foreground.cancel, cleanup = Error('donor cancel failed')
  a.foreground.cancel = async input => { if (input.releaseTokenId) throw cleanup; return cancel(input) }
  await assert.rejects(act(b), error => error instanceof ComputerActionCleanupError && error.actionError?.code === 'FOREGROUND_HANDOFF_DENIED' && error.cleanupErrors[0] === cleanup)
  assert.equal(b.state.act, 0); assert.equal(a.state.grant, 1); assert.equal(scheduler.foregroundDonor('local-desktop'), undefined)
  a.foreground.cancel = cancel; await close(a, b)
})
