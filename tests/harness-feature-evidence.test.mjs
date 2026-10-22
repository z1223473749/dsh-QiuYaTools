import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { archiveCollectionEvidence, fixturePlanRevisionText, planRevisionEvidence, projectHarnessArchiveSnapshot, projectHarnessPlanSnapshot, readOwnedHarnessFeatureEvidence, waitForInlinePaint } from '../scripts/harness-feature-evidence.mjs'

const binding = { workspaceId: 'workspace-own', workspacePath: '/fixture/own-workspace', selectedSessionIds: ['session-beta', 'session-gamma'], preservedSessionIds: ['session-alpha'], plan: { sessionId: 'session-plan', quote: '检查真实会话和插件菜单。', note: 'E2E 请增加真实回归测试' } }
binding.plan.expectedText = fixturePlanRevisionText(binding.plan.quote, binding.plan.note)
const workspace = { id: binding.workspaceId, path: binding.workspacePath, sessionIds: ['session-alpha', 'session-beta', 'session-gamma'] }
const archiveBefore = () => projectHarnessArchiveSnapshot(workspace, ['session-already-archived'], binding)
const archiveAfter = () => projectHarnessArchiveSnapshot(workspace, ['session-already-archived', 'session-beta', 'session-gamma'], binding)
const user = (seq, text = binding.plan.expectedText, source = { kind: 'user' }) => ({ type: 'user/message', seq, data: { source, content: [{ type: 'text', text }] } })
const surface = (events, capturedThroughSeq = events.at(-1)?.seq ?? null) => ({ session: { id: 'session-plan' }, capturedThroughSeq, events })
const planBefore = () => projectHarnessPlanSnapshot(surface([user(3, 'E2E:plan')], 8), binding)
const planAfter = () => projectHarnessPlanSnapshot(surface([user(3, 'E2E:plan'), user(12)], 14), binding)

test('archive evidence requires the exact durable archive delta and keeps Alpha accounted and unarchived', () => {
  const value = archiveCollectionEvidence(archiveBefore(), archiveAfter())
  assert.equal(value.passed, true); assert.deepEqual(value.addedArchivedSessionIds, ['session-beta', 'session-gamma']); assert.equal(value.alphaPreserved, true)
  for (const change of [v => v.archivedSessionIds = ['session-already-archived'], v => v.archivedSessionIds.push('session-alpha'), v => v.archivedSessionIds.push('session-unselected'), v => v.archivedSessionIds.shift(), v => v.memberSessionIds = ['session-beta', 'session-gamma'], v => v.workspaceId = 'workspace-other', v => v.selectedSessionIds = ['session-alpha']]) {
    const after = archiveAfter(); change(after); assert.equal(archiveCollectionEvidence(archiveBefore(), after).passed, false)
  }
  assert.equal(archiveCollectionEvidence(archiveAfter(), archiveAfter()).passed, false, 'Already archived rows cannot count as this operation')
  assert.throws(() => projectHarnessArchiveSnapshot({ ...workspace, path: '/other' }, [], binding), /exact own/u)
})

test('plan evidence accepts exactly one newer ordinary user/message containing the complete bound revision', () => {
  const result = planRevisionEvidence(planBefore(), planAfter())
  assert.equal(result.passed, true); assert.equal(result.userMessageSeq, 12); assert.equal(result.beforeSeq, 8)
  assert.equal(result.matchingUserMessageCount, 1)
  assert.equal(JSON.stringify(result).includes(binding.plan.note), false, 'Persist only finite event metadata and digest')
  assert.equal(planRevisionEvidence(projectHarnessPlanSnapshot(surface([]), binding), planAfter()).passed, true, 'SDK empty capture uses null, represented as -1')
})

test('comments visible in tool errors, assistant text or inbox queues never prove main-Agent user-message delivery', () => {
  for (const event of [
    { type: 'tool/result', seq: 12, data: { message: { content: [{ type: 'text', text: binding.plan.expectedText }] } } },
    { type: 'assistant/message', seq: 12, data: { content: [{ type: 'text', text: binding.plan.expectedText }] } },
    { type: 'agent/inbox/spliced', seq: 12, data: { inserted: [user(12).data] } },
    user(12, binding.plan.expectedText, { kind: 'subagent' }), user(12, binding.plan.note), user(12, binding.plan.quote),
  ]) assert.equal(planRevisionEvidence(planBefore(), projectHarnessPlanSnapshot(surface([event], 14), binding)).passed, false)
  assert.equal(planRevisionEvidence(planBefore(), projectHarnessPlanSnapshot(surface([user(5)], 14), binding)).passed, false, 'A historical message before the click cannot satisfy the test')
  assert.equal(planRevisionEvidence(planBefore(), projectHarnessPlanSnapshot(surface([user(12), user(13)], 14), binding)).passed, false, 'Duplicate revision delivery is a failure')
})

test('plan projection rejects wrong identities, unavailable cuts and malformed ordinary-message sequences', () => {
  assert.throws(() => projectHarnessPlanSnapshot({ ...surface([]), session: { id: 'session-foreign' } }, binding), /exact own plan/u)
  assert.throws(() => projectHarnessPlanSnapshot(surface([user(12)], 11), binding), /sequence/u)
  assert.throws(() => projectHarnessPlanSnapshot(surface([user(12), user(12)], 14), binding), /sequence/u)
  assert.throws(() => projectHarnessPlanSnapshot(surface([user(12)], undefined), { plan: { ...binding.plan, expectedText: 'unrelated text' } }), /not bound/u)
  assert.equal(planRevisionEvidence(planBefore(), { ...planAfter(), sessionId: 'session-other' }).passed, false)
  assert.equal(planRevisionEvidence(planBefore(), { ...planAfter(), expectedTextSHA256: 'a'.repeat(64) }).passed, false)
})

test('readback uses only bound public workspace/get and SessionQuery.readSurface APIs', async () => {
  const calls = [], services = { workspaceRegistry: { get(id) { calls.push(['workspace-get', id]); return workspace }, get archivedSessionIds() { calls.push(['archive-set']); return ['session-beta', 'session-gamma'] } }, sessionQuery: { async readSurface(id) { calls.push(['read-surface', id]); return surface([user(12)], 14) } } }
  assert.equal((await readOwnedHarnessFeatureEvidence(services, binding, { kind: 'archive' })).workspaceId, binding.workspaceId)
  assert.equal((await readOwnedHarnessFeatureEvidence(services, binding, { kind: 'plan', sessionId: 'cannot-select-another-session' })).sessionId, binding.plan.sessionId)
  assert.deepEqual(calls, [['workspace-get', 'workspace-own'], ['archive-set'], ['read-surface', 'session-plan']])
  await assert.rejects(readOwnedHarnessFeatureEvidence(services, binding, { kind: 'mutate' }), /Unknown/u)
})

class Canvas extends EventTarget {
  tagName = 'CANVAS'; id = 'screen'; width = 1; height = 1; renderTurns = 0; listeners = 0; visible = true
  ownerDocument = { defaultView: { requestAnimationFrame: callback => setImmediate(() => { this.renderTurns++; callback() }) } }
  addEventListener(...args) { this.listeners++; return super.addEventListener(...args) }
  removeEventListener(...args) { this.listeners--; return super.removeEventListener(...args) }
  getClientRects() { return this.visible ? [{}] : [] }
  paint(detail = { frameId: 'frame:17', width: 1000, height: 760 }) { this.width = detail.width; this.height = detail.height; const event = new Event('qiuya-preview-frame'); event.detail = detail; this.dispatchEvent(event) }
}
test('inline paint callback is serializable and waits for a genuine future frame event plus render opportunity', async () => {
  const screen = new Canvas(), callback = vm.runInNewContext('(' + waitForInlinePaint.toString() + ')', { setTimeout, clearTimeout })
  const result = callback(screen, { timeoutMs: 1000 }); screen.paint()
  const value = await result
  assert.equal(value.painted, true); assert.equal(value.frameId, 'frame:17'); assert.equal(value.width, 1000); assert.equal(value.height, 760)
  assert.equal(value.postEventRenderTurns, 2); assert.equal(screen.renderTurns, 2); assert.equal(screen.listeners, 0)
})
test('canvas geometry, labels or rAF alone and the initial 1x1 placeholder cannot pass inline acceptance', async () => {
  for (const mode of ['geometry-only', 'one-pixel-event', 'missing-id', 'mismatched-dimensions', 'hidden']) {
    const screen = new Canvas(), result = waitForInlinePaint(screen, { timeoutMs: 8 })
    if (mode === 'geometry-only') { screen.width = 1000; screen.height = 760 }
    else if (mode === 'one-pixel-event') screen.paint({ frameId: 'frame:1', width: 1, height: 1 })
    else if (mode === 'missing-id') screen.paint({ width: 1000, height: 760 })
    else if (mode === 'mismatched-dimensions') { screen.paint(); screen.width = 1 }
    else { screen.visible = false; screen.paint() }
    await assert.rejects(result, /real painted frame/u); assert.equal(screen.listeners, 0)
  }
})
