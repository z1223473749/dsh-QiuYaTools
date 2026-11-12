import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/host-agents.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { isLiveRootAgent, listHostAgents } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const agent = (id, meta = {}) => ({ id, session: { header: { id, ...meta } } })

test('0.2.1 roots remain authoritative, independent of durable fork and origin metadata', () => {
  const root = agent('root', { origin: 'subagent' }), child = agent('child')
  const rows = [root, child], registry = { get: id => rows.find(a => a.id === id), roots: () => [root], list: () => rows }
  assert.equal(isLiveRootAgent(registry, root), true)
  assert.equal(isLiveRootAgent(registry, child), false)
  assert.equal(isLiveRootAgent(registry, { ...root }), false)
  assert.deepEqual(listHostAgents(registry), rows)
  delete registry.list
  assert.deepEqual(listHostAgents(registry), [root])
})

test('0.2.2 list plus exact live session classifies main chats, forks, and subagents', () => {
  const main = agent('main'), fork = agent('fork', { parentSession: 'source' }), child = agent('child', { origin: 'subagent' })
  let rows = [main, fork, child]
  const registry = { get: id => rows.find(a => a.id === id), list: () => rows }
  for (const a of [main, fork]) assert.equal(isLiveRootAgent(registry, a), true)
  assert.equal(isLiveRootAgent(registry, child), false)
  const stale = main; rows = [agent('main'), fork, child]
  assert.equal(isLiveRootAgent(registry, stale), false)
  assert.equal(isLiveRootAgent(registry, rows[0]), true)
  rows = []; assert.equal(isLiveRootAgent(registry, fork), false)
})

test('missing or incomplete APIs and inconsistent session identity grant no root authority', () => {
  for (const a of [{ id: 'main' }, { id: 'main', session: {} }, agent('main', { id: 'different' }), agent('main', { origin: 'unknown' })]) {
    assert.equal(isLiveRootAgent({ get: () => a, list: () => [a] }, a), false)
  }
  const a = agent('main')
  assert.equal(isLiveRootAgent(undefined, a), false)
  assert.equal(isLiveRootAgent({ get: () => a }, a), false)
  assert.equal(isLiveRootAgent({ get: () => a, list: () => [] }, a), false)
  assert.equal(isLiveRootAgent({ get: () => a, list: () => [a] }, undefined), false)
  assert.deepEqual(listHostAgents(undefined), [])
})
