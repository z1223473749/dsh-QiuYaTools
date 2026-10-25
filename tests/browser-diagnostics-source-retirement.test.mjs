import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { api, turn } from './fixtures/browser-diagnostics.mjs'

// Real product subscription and service; CDP is a finite in-memory transport.
// No browser, Host, network socket or device input is launched by these tests.
function setup(t) {
  const origin = 'https://isolated.test', agent = { id: 'own-chat' }, calls = [], listeners = new Set()
  let allowed = true
  const browser = new api.BrowserSession({ allowedOrigins: [origin], cdpEndpoint: 'http://127.0.0.1:9222' })
  const emit = (method, params = {}) => { for (const listener of [...listeners]) listener({ method, params, sessionId: 'own-diagnostics' }) }
  browser.connection = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async send(method, params, sessionId, signal) {
      calls.push({ method, params, sessionId }); signal?.throwIfAborted()
      if (method === 'Target.getTargetInfo') return { targetInfo: { type: 'page', targetId: 'own-tab', url: origin + '/page', title: 'isolated' } }
      if (method === 'Target.attachToTarget') return { sessionId: 'own-diagnostics' }
      return {}
    },
    async drainCaptures() {},
    close() { listeners.clear() },
  }
  const context = { chatSessionId: agent.id, environmentId: randomUUID(), workbenchTabId: randomUUID(), targetId: 'own-tab', epoch: 7, assertCurrent() { if (!allowed) throw Error('SITE_REVOKED') } }
  const controller = new AbortController(), owner = { chatSessionId: agent.id, signal: new AbortController().signal, grantSignal: new AbortController().signal, assertCurrent() {}, assertGrantCurrent() {} }
  const registry = {
    capture() { context.assertCurrent(); return context },
    diagnosticSource() { return { origin, subscribe(guard, onEvent, invalidated, signal) { return browser.subscribeDiagnostics(context.targetId, origin, guard, onEvent, invalidated, signal) } } },
  }
  const service = new api.BrowserDiagnosticsService({ registry, enabled: () => true, current: a => a === agent, canRequest: () => true, selected() {} })
  const exec = () => ({ agent, callId: randomUUID(), signal: controller.signal })
  t.after(async () => { await service.dispose(); await browser.close() })
  return {
    service, owner, exec, context, calls, listeners, emit,
    async start() {
      const pending = service.request(exec(), { environmentId: context.environmentId, workbenchTabId: context.workbenchTabId, reason: 'isolated source retirement' })
      pending.catch(() => {})
      await service.decide(owner, service.status(owner).pending[0].requestId, true)
      return pending
    },
    log() { emit('Runtime.consoleAPICalled', { timestamp: Date.now(), type: 'error', args: [{ type: 'string', value: 'not retained raw content' }] }) },
    revokeSite() { allowed = false; browser.setAllowedOrigins([]) },
    record(id) { return service.ownerRead(owner, id) },
    async assertDetachedOnce() { await turn(); assert.equal(calls.filter(c => c.method === 'Target.detachFromTarget').length, 1); assert.equal(listeners.size, 0); assert.equal(calls.some(c => /Input\.|evaluate|getResponseBody|replayXHR/u.test(c.method)), false) },
  }
}

test('source callback before sweep after website revoke clears already saved metadata and rejects the triggering late event', async t => {
  const f = setup(t), record = await f.start(); f.log()
  assert.equal(f.record(record.diagnosticId).entries.length, 1)
  f.revokeSite()
  // Actual BrowserSession guard failure invalidates before the service timer.
  f.emit('Network.loadingFinished', { requestId: 'late', timestamp: 1 })
  await turn()
  const stopped = f.record(record.diagnosticId)
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.reason, 'page-or-authority-changed')
  assert.equal(stopped.entries.length, 0)
  f.log(); assert.equal(f.record(record.diagnosticId).entries.length, 0)
  await f.assertDetachedOnce()
})
test('navigation source invalidation clears only that retired source and detaches once', async t => {
  const f = setup(t), record = await f.start(); f.log()
  f.emit('Page.frameNavigated', { frame: { id: 'own-document' } }); await turn()
  assert.equal(f.record(record.diagnosticId).state, 'stopped')
  assert.equal(f.record(record.diagnosticId).entries.length, 0)
  assert.equal(f.context.epoch, 7)
  await f.assertDetachedOnce()
})
test('explicit model stop preserves diagnostic history despite synchronous signal-abort source callback', async t => {
  const f = setup(t), record = await f.start(); f.log()
  const stopped = await f.service.stop(f.exec(), record.diagnosticId)
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.reason, 'model-stopped'); assert.equal(stopped.entries.length, 1)
  assert.equal(f.record(record.diagnosticId).entries.length, 1)
  await f.assertDetachedOnce()
})
test('explicit owner stop still clears metadata exactly once', async t => {
  const f = setup(t), record = await f.start(); f.log()
  const stopped = await f.service.ownerStop(f.owner, record.diagnosticId)
  assert.equal(stopped.reason, 'owner-revoked'); assert.equal(stopped.entries.length, 0)
  await f.assertDetachedOnce()
})
test('sweep-first website revoke has the same zero retained metadata result without replay', async t => {
  const f = setup(t), record = await f.start(); f.log(); f.revokeSite()
  f.service.sweep(); await turn()
  const stopped = f.record(record.diagnosticId)
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.entries.length, 0)
  await f.assertDetachedOnce()
})
