import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { HARNESS_COMPUTER_PIPELINE_MS, waitForHarnessComputerPipeline, matchesHarnessPreviewControlState, harnessFailedComputerDrained, finalizeHarnessOwnedResources } from '../scripts/harness-computer-pipeline.mjs'

test('a native retirement failure cannot skip browser/Host cleanup or disappear from the failed verdict', async () => {
  const calls = []
  const errors = await finalizeHarnessOwnedResources([
    { name: 'observer-dispose', async run() { calls.push('observer'); throw Object.assign(new Error('PRIVATE_STACK_AND_PATH'), { code: 'NATIVE_CLEANUP_FAILED' }) } },
    { name: 'browser-close', async run() { calls.push('browser') } },
    { name: 'host-shutdown', async run() { calls.push('host'); throw Object.assign(new Error('PRIVATE_TOKEN'), { code: 'PRIVATE_CODE' }) } },
  ])
  assert.deepEqual(calls, ['observer', 'browser', 'host'])
  assert.deepEqual(errors, [{ stage: 'observer-dispose', code: 'NATIVE_CLEANUP_FAILED' }, { stage: 'host-shutdown', code: 'OWNED_CLEANUP_FAILED' }])
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE/u)
})

test('failed-case isolation requires the exact stopped task, idle Agent and both empty own inboxes', () => {
  const value = { agent: { sessionId: 'own-alpha', available: true, state: 'idle', nextTurn: 0, nextStep: 0 }, computer: { sessionId: 'own-alpha', state: 'stopped' }, pending: 0 }
  assert.equal(harnessFailedComputerDrained(value, 'own-alpha'), true)
  for (const patch of [{ sessionId: 'other' }, { available: false }, { state: 'running' }, { nextTurn: 1 }, { nextStep: 1 }, { nextTurn: undefined }]) assert.equal(harnessFailedComputerDrained({ ...value, agent: { ...value.agent, ...patch } }, 'own-alpha'), false)
  for (const patch of [{ sessionId: 'other' }, { state: 'stopping' }, { state: 'faulted' }]) assert.equal(harnessFailedComputerDrained({ ...value, computer: { ...value.computer, ...patch } }, 'own-alpha'), false)
  assert.equal(harnessFailedComputerDrained({ ...value, pending: 1 }, 'own-alpha'), false)
  assert.equal(harnessFailedComputerDrained({ ...value, computer: null }, 'own-alpha'), false)
  assert.equal(harnessFailedComputerDrained({ ...value, computer: null }, 'own-alpha', false), true)
  assert.equal(harnessFailedComputerDrained(value, 'own-alpha', false), false)
  assert.equal(harnessFailedComputerDrained({ ...value, computer: null, pending: 1 }, 'own-alpha', false), false)
})

test('Stop succeeds only after backend stop and the intentionally removed Settings task card', () => {
  const stopped = { settingsVisible: true, backendState: 'stopped', taskCount: 0, taskState: null }
  assert.equal(matchesHarnessPreviewControlState(stopped, 'stopped'), true)
  for (const patch of [{ backendState: 'stopping' }, { backendState: 'humanControl' }, { taskCount: 1, taskState: 'stopped' }, { taskCount: 1, taskState: 'humanControl' }, { settingsVisible: false }]) assert.equal(matchesHarnessPreviewControlState({ ...stopped, ...patch }, 'stopped'), false)
})

test('nonterminal preview controls still require one matching visible task and exact backend state', () => {
  for (const expected of ['paused', 'ready', 'humanControl']) {
    const current = { settingsVisible: true, backendState: expected, taskCount: 1, taskState: expected }
    assert.equal(matchesHarnessPreviewControlState(current, expected), true)
    for (const patch of [{ backendState: 'stopped' }, { taskCount: 0, taskState: null }, { taskCount: 2 }, { taskState: 'running' }, { settingsVisible: false }]) assert.equal(matchesHarnessPreviewControlState({ ...current, ...patch }, expected), false)
  }
  assert.equal(matchesHarnessPreviewControlState({ settingsVisible: true, backendState: 'faulted', taskCount: 1, taskState: 'faulted' }, 'faulted'), false)
})

test('a real multi-turn shape completing after 48 seconds succeeds without changing native deadlines', async () => {
  let now = 0, reads = 0
  const progress = []
  const value = await waitForHarnessComputerPipeline(remaining => {
    reads++; assert.equal(remaining, 90000 - now)
    return { state: 'running', nativeAvailable: true, complete: now >= 48005, stage: now >= 48005 ? 'complete' : now >= 40000 ? 'action-received' : now >= 25000 ? 'image-received' : 'model-turn', turns: Math.floor(now / 4000), hasImage: now >= 25000, hasAction: now >= 40000, ignoredPrivateText: 'never project this' }
  }, { now: () => now, sleep: async milliseconds => { now += milliseconds }, onProgress: value => progress.push(value) })
  assert.equal(value.elapsedMs, 48250)
  assert.equal(reads, 194)
  assert.equal(value.stage, 'complete')
  assert.equal(value.hasAction, true)
  assert.ok(progress.some(value => value.stage === 'image-received'))
  assert.doesNotMatch(JSON.stringify(progress), /Private|never project/u)
  assert.equal(HARNESS_COMPUTER_PIPELINE_MS, 90000)
})

test('progress never resets the fixed 90-second deadline', async () => {
  let now = 0, reads = 0
  await assert.rejects(waitForHarnessComputerPipeline(() => ({ state: 'running', stage: 'model-turn', turns: ++reads }), { now: () => now, sleep: async milliseconds => { now += milliseconds } }), /within 90000 ms/u)
  assert.equal(now, 90000)
  assert.equal(reads, 360)
})

test('late completion cannot turn an over-budget read into success', async () => {
  let now = 0
  await assert.rejects(waitForHarnessComputerPipeline(() => { now = 90001; return { complete: true } }, { now: () => now, sleep: async () => { throw new Error('No extra waiting') } }), /within 90000 ms/u)
})

test('paused, faulted and native/tool failures stop immediately without another wait or action', async () => {
  for (const value of [{ state: 'paused' }, { state: 'humanControl' }, { state: 'faulted' }, { state: 'disconnected' }, { state: 'ready', failed: true }, { state: 'running', nativeAvailable: false }]) {
    let reads = 0
    await assert.rejects(waitForHarnessComputerPipeline(() => { reads++; return value }, { sleep: async () => { throw new Error('Should not wait') } }), /stopped before verification/u)
    assert.equal(reads, 1)
  }
})

test('unknown session state may settle before completion and cannot expose raw metadata', async () => {
  let now = 0
  const samples = []
  await waitForHarnessComputerPipeline(() => now ? { complete: true, state: 'running', stage: 'complete' } : { state: 'private-state', stage: 'private-stage', turns: 'private-turn' }, { now: () => now, sleep: async milliseconds => { now += milliseconds }, onProgress: value => samples.push(value) })
  assert.equal(samples[0].state, null)
  assert.equal(samples[0].stage, 'model-turn')
  assert.equal(samples[0].turns, null)
  assert.doesNotMatch(JSON.stringify(samples), /private-/u)
})

test('only the final multi-turn computer wait changes and every Windows/runtime transfer includes its helper', async () => {
  const [ui, carrier, runtime] = await Promise.all(['scripts/e2e-harness.mjs', 'scripts/e2e-windows-harness-pd.mjs', 'scripts/prepare-windows-test-runtime.mjs'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))
  assert.ok(ui.includes('await waitForHarnessComputerPipeline('))
  assert.ok(ui.includes("join(output, 'computer-pipeline-progress.json')"))
  assert.ok(ui.includes('await approval.waitFor({ timeout: 25000 })'))
  assert.ok(ui.includes("'Isolated Harness did not start', 90000"))
  assert.ok(carrier.includes("['harness-computer-pipeline.mjs', await readFile('scripts/harness-computer-pipeline.mjs')]"))
  assert.ok(carrier.includes("['harness-computer-pipeline.mjs', 'scripts/harness-computer-pipeline.mjs']"))
  assert.ok(runtime.includes("'scripts/harness-computer-pipeline.mjs'"))
})
