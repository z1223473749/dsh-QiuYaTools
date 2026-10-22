import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './fixtures/harness-e2e-provider.mjs'

test('drain oracle is owner-only, bound to the runner exact SID and never cancels or reads a different Agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiuya-harness-e2e-cleanup-')), previous = { home: process.env.DSH_HOME, gate: process.env.QIUYA_HARNESS_E2E }, handlers = [], reads = []
  process.env.DSH_HOME = directory; process.env.QIUYA_HARNESS_E2E = '1'
  try {
    await writeFile(join(directory, 'e2e-computer-target.json'), JSON.stringify({ sessionId: 'own-alpha' }))
    const connection = { browserPeer: { principal: { kind: 'owner' } }, fetch: { register(value) { handlers.push(value); return () => {} } } }
    apply({ effect(fn) { fn() }, llm: { registerAdapter() { return () => {} } }, agents: { get(id) { reads.push(id); return { status: 'idle', inbox: { nextTurn: [], nextStep: [] }, cancel() { throw new Error('Read-only oracle must not cancel') } } } }, connection })
    const handler = handlers.find(row => row.path === '/api/qiuya-e2e-owned-agent').fetch
    const read = id => handler(new Request('http://localhost/api/qiuya-e2e-owned-agent', { method: 'POST', body: JSON.stringify({ sessionId: id }) }))
    connection.browserPeer.principal.kind = 'guest'; assert.equal((await read('own-alpha')).status, 403); assert.deepEqual(reads, [])
    connection.browserPeer.principal.kind = 'owner'; assert.equal((await read('other-session')).status, 403); assert.deepEqual(reads, [])
    const response = await read('own-alpha'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { sessionId: 'own-alpha', available: true, state: 'idle', nextTurn: 0, nextStep: 0 }); assert.deepEqual(reads, ['own-alpha'])
  } finally { previous.home === undefined ? delete process.env.DSH_HOME : process.env.DSH_HOME = previous.home; previous.gate === undefined ? delete process.env.QIUYA_HARNESS_E2E : process.env.QIUYA_HARNESS_E2E = previous.gate; await rm(directory, { recursive: true, force: true }) }
})
