import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import * as storeEngine from '@deepseek-ai/dsh-client-store'

const require = createRequire(import.meta.url)
const built = await build({
  stdin: {
    contents: [
      "export * from './src/features/plan-comments/plan-comments.ts'",
      "export * from './src/features/plan-comments/comment-dom.ts'",
      "export * from './src/features/plan-comments/revision-submissions.ts'",
      "export * from './src/features/plan-comments/PlanReviewSurface.tsx'",
      "export { PlanReviewComposer, installPlanComments } from './src/features/plan-comments/index.tsx'",
      "export { en as messages } from './src/features/plan-comments/locales.ts'",
    ].join(';'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts',
  },
  write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'test-css-modules', setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default new Proxy({}, { get: (_target, key) => String(key) })', loader: 'js' }))
  } }],
})
const primitives = {
  Button: ({ variant, size, icon, children, ...props }) => React.createElement('button', { type: 'button', ...props }, icon, children),
  StateDot: () => React.createElement('span', { 'aria-hidden': true }),
  IconEditOutlineRegular: () => null,
  IconTrashOutlineRegular: () => null,
  extractMarkdownPlainText: (markdown, { mode }) => mode === 'first-line'
    ? markdown.split('\n')[0].replace(/^#+\s*/, '')
    : markdown.split('\n').find(line => line.trim() !== '' && !line.startsWith('#')) ?? '',
}
const module = { exports: {} }
const runtime = {
  module, exports: module.exports, Error, __QYT_BUNDLED_CSS__: '',
  require(id) {
    if (id === '@deepseek-ai/dsh-client-store') return storeEngine
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    return require(id)
  },
}
vm.runInNewContext(built.outputFiles[0].text, runtime)
const {
  createPlanCommentsStore, EMPTY_PLAN_COMMENTS, planCommentKey, locatePlanComment,
  renderedPlanText, selectionPlanAnchor, planTextRange, planHighlightRanges,
  watchRevisionSubmissions, PlanReviewSurface, messages,
  PlanReviewComposer, installPlanComments,
} = module.exports
const json = value => JSON.parse(JSON.stringify(value))
const plan = '# Ship the picker\n\nRead the store before implementation.'
const sessionA = 'session-a'
const sessionB = 'session-b'
const key = planCommentKey(sessionA, 'call-a', plan)
const baseComment = { id: 'comment-a', planKey: key, quote: 'Read the store', note: 'Add a test', start: 0, end: 14, prefix: '', suffix: ' before implementation.' }
const storageKey = session => `qiuyaTools.plan-comments.v1.${session}`
const translate = (key, params) => (messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]))

function browser(t, html = '') {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url: 'https://plan.test/' })
  runtime.localStorage = dom.window.localStorage
  runtime.NodeFilter = dom.window.NodeFilter
  runtime.document = dom.window.document
  t.after(() => { delete runtime.localStorage; delete runtime.NodeFilter; delete runtime.document; dom.window.close() })
  return dom
}

test('plan comments persist per session while editability, missing highlights and in-flight UI state remain transient', t => {
  const dom = browser(t)
  const first = createPlanCommentsStore().create(sessionA)
  first.actions.save(baseComment)
  first.actions.setEditable(key, true)
  first.actions.setSending(key, true)
  first.actions.setMissing(key, [baseComment.id])
  first.actions.stage(key, 'Revision draft', [baseComment.id], 100)
  const restored = createPlanCommentsStore().create(sessionA)
  assert.deepEqual(json(restored.getSnapshot().commentsByPlan[key]), [baseComment])
  assert.deepEqual(json(restored.getSnapshot().stagedByPlan[key]), { draft: 'Revision draft', ids: [baseComment.id], afterSeq: 100 })
  assert.equal(restored.getSnapshot().editableByPlan[key], undefined)
  assert.equal(restored.getSnapshot().sendingByPlan[key], undefined)
  assert.equal(restored.getSnapshot().missingByPlan[key], undefined)
  const persisted = JSON.parse(dom.window.localStorage.getItem(storageKey(sessionA)))
  assert.deepEqual(Object.keys(persisted).sort(), ['commentsByPlan', 'stagedByPlan'])
})

test('session and invocation identities isolate comments, stores, persistent keys, and delimiter-containing ids', t => {
  browser(t)
  const handle = createPlanCommentsStore()
  const first = handle.create(sessionA)
  const second = handle.create(sessionB)
  first.actions.save(baseComment)
  assert.equal(second.getSnapshot().commentsByPlan[key], undefined)
  assert.equal(handle.create(sessionB).getSnapshot().commentsByPlan[key], undefined)
  assert.notEqual(planCommentKey(sessionB, 'call-a', plan), key)
  assert.notEqual(planCommentKey(sessionA, 'call-b', plan), key)
  assert.notEqual(planCommentKey(sessionA, 'call-a', '# Changed plan'), key)
  assert.notEqual(planCommentKey('session:a', 'call', 'text'), planCommentKey('session', 'a:call', 'text'))
})

test('the real store engine preserves snapshot identity for no changes and publishes actual edits once', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  let notifications = 0
  const first = store.getSnapshot()
  assert.equal(first, store.getSnapshot())
  assert.equal(first.commentsByPlan[key] ?? EMPTY_PLAN_COMMENTS, EMPTY_PLAN_COMMENTS)
  const unsubscribe = store.subscribe(() => { notifications++ })
  store.actions.save(baseComment)
  store.actions.save({ ...baseComment, note: 'Updated' })
  assert.equal(notifications, 2)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [{ ...baseComment, note: 'Updated' }])
  unsubscribe()
  store.actions.clear(key)
  assert.equal(notifications, 2)
})

test('restore filters malformed anchors, duplicate ids, mismatched plan keys, and invalid staged references', t => {
  const dom = browser(t)
  dom.window.localStorage.setItem(storageKey(sessionA), JSON.stringify({
    commentsByPlan: {
      [key]: [baseComment, baseComment, { ...baseComment, id: 'negative', start: -1 }, { ...baseComment, id: 'fraction', start: .5 },
        { ...baseComment, id: 'range', end: 5 }, { ...baseComment, id: 'empty', note: '  ' }, { ...baseComment, id: 'other', planKey: 'other-key' },
        { ...baseComment, id: 'bad-context', prefix: 1 }],
      other: 'not an array',
    },
    stagedByPlan: { [key]: { draft: 'Draft', ids: [baseComment.id, 'missing', 1, baseComment.id], afterSeq: 100 }, invalid: { draft: 'Bad', ids: ['missing'], afterSeq: .5 } },
  }))
  const restored = createPlanCommentsStore().create(sessionA).getSnapshot()
  assert.deepEqual(json(restored.commentsByPlan[key]), [baseComment])
  assert.deepEqual(json(restored.stagedByPlan[key]), { draft: 'Draft', ids: [baseComment.id], afterSeq: 100 })
  assert.equal(restored.stagedByPlan.invalid, undefined)
})

test('malformed JSON and browser storage failures leave the in-memory interaction usable', t => {
  const dom = browser(t)
  dom.window.localStorage.setItem(storageKey(sessionA), '{invalid')
  assert.equal(createPlanCommentsStore().create(sessionA).getSnapshot().commentsByPlan[key], undefined)
  runtime.localStorage = {
    getItem() { throw new Error('Unavailable') },
    setItem() { throw new Error('Quota exceeded') },
    removeItem() { throw new Error('Unavailable') },
  }
  const store = createPlanCommentsStore().create(sessionA)
  assert.doesNotThrow(() => { store.actions.save(baseComment); store.clearPersisted() })
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [baseComment])
})

test('staging never clears annotations; only exact delivered text with seq greater than afterSeq removes staged ids', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  const later = { ...baseComment, id: 'later', note: 'Preserve later comment' }
  store.actions.save(baseComment)
  store.actions.stage(key, 'Draft', [baseComment.id], 100)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [baseComment])
  store.actions.save(later)
  for (const [text, seq] of [['Edited draft', 101], ['Draft', 50], ['Draft', 100]]) store.actions.confirm(key, text, seq)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [baseComment, later])
  store.actions.confirm(key, 'Draft', 101)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [later])
  assert.equal(store.getSnapshot().stagedByPlan[key], undefined)
})

test('failed submission unstages its matching draft while preserving comments and newer retry submissions', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  store.actions.save(baseComment)
  store.actions.stage(key, 'New request', [baseComment.id], 100)
  store.actions.unstage(key, 'Old request')
  assert.equal(store.getSnapshot().stagedByPlan[key].draft, 'New request')
  store.actions.unstage(key, 'New request')
  assert.equal(store.getSnapshot().stagedByPlan[key], undefined)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [baseComment])
})

test('durable confirmations do not consume other invocation revisions or comments added after staging', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  const otherKey = planCommentKey(sessionA, 'call-b', '# Other plan')
  const other = { ...baseComment, id: 'other', planKey: otherKey }
  const later = { ...baseComment, id: 'later', note: 'Added later' }
  store.actions.save(baseComment); store.actions.save(other)
  store.actions.stage(key, 'Revision request', [baseComment.id], 100)
  store.actions.stage(otherKey, 'Other request', [other.id], 100)
  store.actions.save(later)
  store.actions.confirmSubmitted('Revision request', 100)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [baseComment, later])
  store.actions.confirmSubmitted('Revision request', 101)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [later])
  assert.equal(store.getSnapshot().stagedByPlan[key], undefined)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[otherKey]), [other])
  assert.equal(store.getSnapshot().stagedByPlan[otherKey].draft, 'Other request')
})

test('restored stages reject replayed earlier text and support the first durable event after cursor -1', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  store.actions.save(baseComment); store.actions.stage(key, 'Same draft', [baseComment.id], 100)
  const restored = createPlanCommentsStore().create(sessionA)
  restored.actions.confirm(key, 'Same draft', 50)
  restored.actions.confirm(key, 'Same draft', 100)
  assert.deepEqual(json(restored.getSnapshot().commentsByPlan[key]), [baseComment])
  restored.actions.confirm(key, 'Same draft', 101)
  assert.equal(restored.getSnapshot().commentsByPlan[key], undefined)
  restored.actions.save(baseComment); restored.actions.stage(key, 'First draft', [baseComment.id], -1)
  const first = createPlanCommentsStore().create(sessionA)
  assert.equal(first.getSnapshot().stagedByPlan[key].afterSeq, -1)
  first.actions.confirm(key, 'First draft', 0)
  assert.equal(first.getSnapshot().commentsByPlan[key], undefined)
})

test('delivery of an older revision preserves edits to staged comments and keeps unedited staged siblings removable', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  const sibling = { ...baseComment, id: 'sibling', note: 'Unedited' }
  const edited = { ...baseComment, note: 'Edited after submission' }
  store.actions.save(baseComment); store.actions.save(sibling)
  store.actions.stage(key, 'Old draft', [baseComment.id, sibling.id], 100)
  store.actions.save(edited)
  assert.deepEqual(Array.from(store.getSnapshot().stagedByPlan[key].ids), [sibling.id])
  store.actions.confirmSubmitted('Old draft', 101)
  assert.deepEqual(json(store.getSnapshot().commentsByPlan[key]), [edited])
})

test('explicit cancellation and individual removals clear only the intended plan and durable browser key', t => {
  const dom = browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  store.actions.save(baseComment)
  store.actions.save({ ...baseComment, id: 'comment-b' })
  store.actions.stage(key, 'Draft', [baseComment.id], 100)
  store.actions.remove(key, [baseComment.id])
  assert.deepEqual(Array.from(store.getSnapshot().commentsByPlan[key], item => item.id), ['comment-b'])
  store.actions.clear(key)
  assert.equal(store.getSnapshot().commentsByPlan[key], undefined)
  assert.equal(store.getSnapshot().stagedByPlan[key], undefined)
  store.clearPersisted()
  assert.equal(dom.window.localStorage.getItem(storageKey(sessionA)), null)
})

test('changed plan text adopts the same invocation comments without losing notes or borrowing another invocation', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  const otherKey = planCommentKey(sessionA, 'call-b', plan)
  const nextKey = planCommentKey(sessionA, 'call-a', '# Changed\nDifferent text')
  store.actions.save(baseComment)
  store.actions.save({ ...baseComment, id: 'other', planKey: otherKey })
  store.actions.stage(key, 'Old revision', [baseComment.id], 100)
  store.actions.setEditable(key, true); store.actions.setMissing(key, [baseComment.id])
  store.actions.adopt(nextKey)
  const state = store.getSnapshot()
  assert.deepEqual(json(state.commentsByPlan[nextKey]), [{ ...baseComment, planKey: nextKey }])
  assert.equal(locatePlanComment('ChangedDifferent text', state.commentsByPlan[nextKey][0]), undefined)
  assert.equal(state.commentsByPlan[otherKey][0].id, 'other')
  for (const field of ['commentsByPlan', 'editableByPlan', 'missingByPlan', 'stagedByPlan']) assert.equal(state[field][key], undefined)
  store.actions.adopt(nextKey)
  assert.equal(store.getSnapshot(), state, 'a repeat adopt must not republish unchanged state')
})

test('missing-anchor preview status publishes only changes and never persists temporary preview state', t => {
  browser(t)
  const store = createPlanCommentsStore().create(sessionA)
  let notifications = 0
  store.subscribe(() => { notifications++ })
  store.actions.setMissing(key, [baseComment.id]); store.actions.setMissing(key, [baseComment.id])
  assert.equal(notifications, 1)
  assert.equal(createPlanCommentsStore().create(sessionA).getSnapshot().missingByPlan[key], undefined)
  store.actions.setMissing(key, []); store.actions.setMissing(key, [])
  assert.equal(notifications, 2)
})

test('anchors verify original offsets and relocate unique quotes or matching repeated-quote context', () => {
  const comment = { ...baseComment, quote: 'Review', start: 0, end: 6, suffix: ' this text' }
  assert.deepEqual(json(locatePlanComment('Review this text', comment)), { start: 0, end: 6 })
  assert.deepEqual(json(locatePlanComment('New: Review this text', comment)), { start: 5, end: 11 })
  assert.deepEqual(json(locatePlanComment('Review other text; Review this text', comment)), { start: 19, end: 25 })
  const { prefix, suffix, ...withoutContext } = comment
  assert.equal(locatePlanComment('Changed this text', comment), undefined)
  assert.equal(locatePlanComment('prefix Review this text; Review this text', withoutContext), undefined)
  assert.equal(locatePlanComment('prefix Review this text; Review this text', { ...withoutContext, suffix }), undefined)
})

test('rendered selection offsets cross inline Markdown nodes, trim whitespace, and leave source DOM unchanged', t => {
  const dom = browser(t, '<div id="plan"><p>  Review <code>serial</code> and <strong>parallel</strong> now  </p></div>')
  const root = dom.window.document.querySelector('#plan')
  const html = root.innerHTML
  const paragraph = root.firstElementChild
  const range = dom.window.document.createRange()
  range.setStart(paragraph.firstChild, 0)
  range.setEnd(paragraph.lastChild, paragraph.lastChild.length)
  const anchor = selectionPlanAnchor(root, range)
  assert.deepEqual(json(anchor), { quote: 'Review serial and parallel now', start: 2, end: 32, prefix: '  ', suffix: '  ' })
  assert.equal(planTextRange(root, anchor.start, anchor.end).toString(), anchor.quote)
  assert.equal(Array.from(planHighlightRanges(root, anchor.start, anchor.end), segment => segment.toString()).join(''), anchor.quote)
  assert.equal(root.innerHTML, html)
})

test('duplicate quotes retain the selected occurrence and its surrounding context', t => {
  const dom = browser(t, '<div id="plan"><p>Same <em>item</em>, then same <em>item</em>.</p></div>')
  const root = dom.window.document.querySelector('#plan')
  const second = root.querySelectorAll('em')[1].firstChild
  const range = dom.window.document.createRange()
  range.setStart(second, 0); range.setEnd(second, 4)
  const anchor = selectionPlanAnchor(root, range)
  assert.equal(anchor.start, 21)
  assert.equal(anchor.quote, 'item')
  assert.equal(anchor.prefix, 'Same item, then same ')
  assert.equal(planTextRange(root, anchor.start, anchor.end).startContainer, second)
})

test('controls, decorative text and code banners do not contaminate rendered offsets or highlights', t => {
  const dom = browser(t, '<div id="plan"><div data-code-block-banner>Code<button>Copy</button></div><p>first <code>second</code> third</p><button>Action</button><span aria-hidden="true">Icon</span><svg><text>SVG</text></svg><script>script</script><style>style</style></div>')
  const root = dom.window.document.querySelector('#plan')
  const range = dom.window.document.createRange()
  range.selectNodeContents(root.querySelector('p'))
  assert.equal(renderedPlanText(root), 'first second third')
  assert.equal(selectionPlanAnchor(root, range).quote, 'first second third')
  assert.equal(planTextRange(root, 6, 12).toString(), 'second')
  assert.equal(Array.from(planHighlightRanges(root, 0, 18), item => item.toString()).join(''), 'first second third')
})

test('collapsed, whitespace-only, outside-document and invalid-offset selections do not produce anchors or highlights', t => {
  const dom = browser(t, '<div id="plan"><p>  plan  </p></div><div id="outside">Outside</div>')
  const root = dom.window.document.querySelector('#plan')
  const range = dom.window.document.createRange()
  range.setStart(root.firstElementChild.firstChild, 0); range.setEnd(root.firstElementChild.firstChild, 2)
  assert.equal(selectionPlanAnchor(root, range), undefined)
  range.collapse()
  assert.equal(selectionPlanAnchor(root, range), undefined)
  range.selectNodeContents(dom.window.document.querySelector('#outside'))
  assert.equal(selectionPlanAnchor(root, range), undefined)
  for (const [start, end] of [[-1, 2], [2, 2], [2, 99]]) assert.equal(planTextRange(root, start, end), undefined)
  assert.equal(planHighlightRanges(root, 2, 99).length, 0)
})

function userMessage(seq, text, options = {}) {
  return { type: 'event', event: { seq, type: options.type ?? 'user/message', data: { source: { kind: options.source ?? 'user' }, content: [{ type: 'text', text }] } } }
}

test('revision receipts inspect durable user text, reject transient/assistant/tool echoes, and release the exact subscription', () => {
  let listener
  let stopped = 0
  const recorded = []
  let snapshot = { revision: 0, entries: [userMessage(1, 'First draft')], change: { kind: 'append', entries: [] } }
  const source = {
    getSnapshot: () => snapshot,
    subscribe: callback => { listener = callback; return () => { stopped++ } },
  }
  const dispose = watchRevisionSubmissions(source, (text, seq) => { recorded.push([text, seq]) })
  assert.deepEqual(recorded, [['First draft', 1]])
  snapshot = { revision: 1, entries: [], change: { kind: 'append', entries: [
    { type: 'transient', event: userMessage(2, 'Transient').event }, userMessage(3, 'Assistant', { type: 'assistant/message' }),
    userMessage(4, 'Tool', { source: 'tool' }), userMessage(5, 'Next draft'),
  ] } }
  listener(); listener()
  assert.deepEqual(recorded, [['First draft', 1], ['Next draft', 5]])
  snapshot = { revision: 2, entries: [], change: { kind: 'settle-assistant', entries: [userMessage(6, 'Do not rescan')] } }
  listener()
  assert.equal(recorded.length, 2)
  dispose()
  assert.equal(stopped, 1)
})

function surfaceFixture(t, { readOnly = false, channel = 'waterfall', send, dismiss: doDismiss, answer: doAnswer, composer = false, mounted = true } = {}) {
  const dom = browser(t, '<div id="app"></div>')
  const previous = new Map()
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[name] })
  }
  const comments = createPlanCommentsStore().create(sessionA)
  const calls = { send: [], dismiss: 0, answer: [], approve: 0, focus: 0, binds: 0, unbinds: 0, open: [], autoOpen: [] }
  const card = { state: channel === 'rpc' ? 'continued' : 'open', closed: readOnly, channel: readOnly ? 'none' : channel }
  let isMounted = mounted
  const pending = {
    key: 'pending-review-a', review: readOnly ? [] : undefined,
    snapshot: () => card,
    subscribe: () => () => {},
    dismiss: async () => { calls.dismiss++; return doDismiss ? doDismiss() : true },
    answer: async payload => { calls.answer.push(payload); await doAnswer?.(payload) },
  }
  const props = {
    pending,
    review: { id: 'plan-review', question: 'Approve this plan?', plan, callId: 'call-a', approve: { label: 'Approve' }, decline: { label: 'Request changes' } },
    requestKey: pending.key, preview: React.createElement('button', { type: 'button' }, 'View full plan'),
    card: pending.snapshot(), busy: false, error: null, sessionId: sessionA,
    approve: () => { calls.approve++ },
    dismiss: async () => { calls.dismiss++; return doDismiss ? doDismiss() : true },
    bindReview: () => { calls.binds++; return () => { calls.unbinds++ } },
    submissionCursor: () => 100,
    sendRevision: async text => { calls.send.push(text); await send?.(text) },
    focusComposer: () => { calls.focus++ },
    useStore: selector => useSyncExternalStore(comments.subscribe, () => selector(comments.getSnapshot()), () => selector(comments.getSnapshot())),
    actions: comments.actions, t: translate,
    openReview: (...args) => { calls.open.push(args) },
    openReviewOnce: (...args) => { calls.autoOpen.push(args) },
    useSidebarMounted: selector => selector(isMounted ? sessionA : undefined),
  }
  props.matched = { pending, review: props.review }
  const Component = composer ? PlanReviewComposer : PlanReviewSurface
  const root = createRoot(dom.window.document.querySelector('#app'))
  act(() => { root.render(React.createElement(Component, props)) })
  t.after(() => {
    act(() => { root.unmount() })
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  const buttons = () => [...dom.window.document.querySelectorAll('button')]
  const button = name => buttons().find(item => (item.getAttribute('aria-label') ?? item.textContent) === name)
  return {
    dom, comments, props, calls, button,
    render: nextProps => { act(() => { root.render(React.createElement(Component, nextProps)) }) },
    setMounted: value => { isMounted = value; act(() => { root.render(React.createElement(Component, { ...props })) }) },
    save: (id = baseComment.id) => { act(() => { comments.actions.save({ ...baseComment, id }) }) },
    click: async name => { await act(async () => { button(name).click(); await setImmediate() }) },
    variant: () => {
      assert.equal(dom.window.document.querySelectorAll('[data-plan-review-surface]').length, 1)
      return dom.window.document.querySelector('[data-plan-review-surface]').getAttribute('data-plan-review-variant')
    },
    status: () => dom.window.document.querySelector('[role="status"]').textContent,
  }
}

test('one review card switches to revision on the first comment and returns to review after deleting the last', async t => {
  const f = surfaceFixture(t)
  const original = f.dom.window.document.querySelector('[data-plan-review-surface]')
  assert.equal(f.variant(), 'review')
  assert.ok(f.button('Approve'))
  f.save()
  assert.equal(f.variant(), 'revision')
  assert.equal(f.dom.window.document.querySelector('[data-plan-review-surface]'), original)
  assert.equal(f.button('Approve'), undefined)
  assert.ok(f.button('Revise plan'))
  await f.click('Delete comment')
  assert.equal(f.variant(), 'review')
  assert.equal(f.dom.window.document.querySelector('[data-plan-review-surface]'), original)
  assert.equal(f.button('Revise plan'), undefined)
})

test('failed revision submission preserves comments and permits retry without an extra card or premature dismissal', async t => {
  let fail = true
  const f = surfaceFixture(t, { send: async () => { if (fail) throw new Error('Offline') } })
  f.save()
  await f.click('Revise plan')
  assert.match(f.status(), /Offline/)
  assert.equal(f.comments.getSnapshot().commentsByPlan[key].length, 1)
  assert.equal(f.comments.getSnapshot().stagedByPlan[key], undefined)
  assert.equal(f.calls.dismiss, 0)
  assert.deepEqual(f.calls.answer, [])
  assert.equal(f.button('Revise plan').disabled, false)
  fail = false
  await f.click('Revise plan')
  assert.equal(f.calls.send.length, 2)
  assert.equal(f.calls.dismiss, 1)
  assert.equal(f.comments.getSnapshot().commentsByPlan[key].length, 1)
  assert.equal(f.comments.getSnapshot().stagedByPlan[key].afterSeq, 100)
  assert.equal(f.status(), '')
  assert.equal(f.variant(), 'revision')
})

test('accepted revision retries dismissal without resubmitting the prompt and clears only after its durable receipt', async t => {
  let failDismiss = true
  const f = surfaceFixture(t, { dismiss: async () => { if (failDismiss) throw new Error('Dismiss failed'); return true } })
  f.save()
  await f.click('Revise plan')
  assert.match(f.status(), /Dismiss failed/)
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.comments.getSnapshot().commentsByPlan[key].length, 1)
  assert.ok(f.comments.getSnapshot().stagedByPlan[key])
  failDismiss = false
  await f.click('Revise plan')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.dismiss, 2)
  act(() => { f.comments.actions.confirmSubmitted(f.calls.send[0], 100) })
  assert.equal(f.comments.getSnapshot().commentsByPlan[key].length, 1)
  act(() => { f.comments.actions.confirmSubmitted(f.calls.send[0], 101) })
  assert.equal(f.comments.getSnapshot().commentsByPlan[key], undefined)
})

test('revision direct-send admission blocks repeated clicks, deletion and cancellation until the request settles', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = surfaceFixture(t, { send: () => gate })
  f.save()
  const revise = f.button('Revise plan')
  await act(async () => { revise.click(); revise.click(); await setImmediate() })
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.answer.length, 0)
  assert.equal(f.calls.dismiss, 0)
  assert.equal(revise.disabled, true)
  assert.equal(f.button('Cancel plan').disabled, true)
  assert.equal(f.button('Delete comment').disabled, true)
  await act(async () => { release(); await setImmediate() })
  assert.equal(f.calls.dismiss, 1)
  assert.equal(f.calls.answer.length, 1)
  assert.equal(f.button('Revise plan').disabled, false)
})

test('settled plan reviews retain readable comments while exposing only Close, and continued RPC reviews avoid a second answer', async t => {
  const f = surfaceFixture(t, { readOnly: true })
  f.save()
  assert.equal(f.variant(), 'revision')
  assert.match(f.dom.window.document.body.textContent, /Add a test/)
  assert.equal(f.button('Revise plan'), undefined)
  assert.equal(f.button('Delete comment'), undefined)
  assert.equal(f.dom.window.document.querySelector('input[type="checkbox"]'), null)
  assert.ok(f.button('Close'))
  await f.click('Close')
  assert.equal(f.calls.dismiss, 1)
  assert.equal(f.comments.getSnapshot().commentsByPlan[key].length, 1)
})

test('continued RPC plan revisions send the prompt and dismiss without sending another structured answer', async t => {
  const f = surfaceFixture(t, { channel: 'rpc' })
  f.save()
  await f.click('Revise plan')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.dismiss, 1)
  assert.deepEqual(f.calls.answer, [])
})

test('composer request identity remounts local busy/error/answer state when its selector matches a different pending review', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = surfaceFixture(t, { composer: true, answer: () => gate })
  await f.click('Approve')
  assert.equal(f.button('Approve').disabled, true)
  assert.equal(f.calls.answer.length, 1)
  const nextCard = { state: 'open', closed: false, channel: 'waterfall' }
  let nextAnswers = 0
  const pending = { ...f.props.pending, key: 'pending-review-b', snapshot: () => nextCard, answer: async () => { nextAnswers++ } }
  const review = { ...f.props.review, callId: 'call-b' }
  f.render({ ...f.props, matched: { pending, review } })
  assert.equal(f.dom.window.document.querySelector('[data-plan-review-key]').getAttribute('data-plan-review-key'), pending.key)
  assert.equal(f.button('Approve').disabled, false)
  assert.equal(f.status(), '')
  await f.click('Approve')
  assert.equal(nextAnswers, 1)
  await act(async () => { release(); await setImmediate() })
})

test('composer automatic preview opening waits until a sidebar Session is mounted and keeps manual preview available', async t => {
  const f = surfaceFixture(t, { composer: true, mounted: false })
  assert.equal(f.calls.autoOpen.length, 0)
  f.setMounted(true)
  assert.equal(f.calls.autoOpen.length, 1)
  assert.equal(f.calls.autoOpen[0][0], f.props.review)
  assert.equal(f.calls.autoOpen[0][1], f.props.pending.key)
  await f.click('View full plan')
  assert.equal(f.calls.open.length, 1)
})

test('RPC approval accepted before a hide failure becomes read-only; Close retries only hiding and never resends the answer', async t => {
  let hideFails = true
  const f = surfaceFixture(t, { composer: true, channel: 'rpc', dismiss: async () => { if (hideFails) throw new Error('Hide failed'); return true } })
  await f.click('Approve')
  assert.equal(f.calls.answer.length, 1)
  assert.equal(f.calls.dismiss, 1)
  assert.equal(f.button('Approve'), undefined)
  assert.ok(f.button('Close'))
  assert.match(f.status(), /answer was sent/i)
  hideFails = false
  await f.click('Close')
  assert.equal(f.calls.answer.length, 1)
  assert.equal(f.calls.dismiss, 2)
})

test('RPC approval transport failures remain retryable without entering the accepted read-only state', async t => {
  let fail = true
  const f = surfaceFixture(t, { composer: true, channel: 'rpc', answer: async () => { if (fail) throw new Error('Offline') } })
  await f.click('Approve')
  assert.match(f.status(), /Offline/)
  assert.ok(f.button('Approve'))
  assert.equal(f.button('Approve').disabled, false)
  assert.equal(f.button('Close'), undefined)
  fail = false
  await f.click('Approve')
  assert.equal(f.calls.answer.length, 2)
  assert.equal(f.calls.dismiss, 1)
})

test('installer shares one Session store, restores official slots on dispose, and opens each request once across component remounts', async t => {
  const dom = browser(t)
  const registrations = new Map()
  const mounted = storeEngine.createSnapshotStore(sessionA)
  const opened = []
  const prompts = []
  let entries = [userMessage(42, 'Last durable message'), { type: 'transient', event: { seq: 42.5, type: 'assistant/live-chunk' } }]
  let locales = 0
  const ctx = {
    effect: callback => callback(),
    locale: { register: () => { locales++; return () => { locales-- } } },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        registrations.set(options.name, { options, component })
        return () => { registrations.delete(options.name) }
      },
    },
    sessions: {
      subagentAddress: () => undefined,
      binding: () => ({
        eventSource: { getSnapshot: () => ({ entries }) },
        session: { prompt: async (...args) => { prompts.push(args); return { ok: true } } },
      }),
    },
    sidebarRight: { mounted, openResource: (...args) => { opened.push(args) } },
  }
  const dispose = installPlanComments(ctx)
  t.after(dispose)
  const composer = registrations.get('conversation.composer')
  const preview = registrations.get('sidebar.right.pane.tab')
  const receipts = registrations.get('conversation.input.overlay')
  assert.equal(composer.options.priority, -50)
  assert.equal(preview.options.priority, -50)
  assert.equal(preview.options.store, composer.options.store)
  assert.equal(receipts.options.store, composer.options.store)
  assert.equal(composer.options.select({ pendingInteraction: { kind: 'question' } }), null)
  const faceA = composer.options.inject(sessionA)
  const faceARemounted = composer.options.inject(sessionA)
  const faceB = composer.options.inject(sessionB)
  const review = { id: 'plan-review', question: 'Approve?', plan, callId: 'call-a', approve: { label: 'Approve' } }
  assert.equal(faceA.hooks.sidebarMounted, mounted)
  faceA.openReviewOnce(review, 'pending-a')
  faceARemounted.openReviewOnce(review, 'pending-a')
  assert.equal(opened.length, 1)
  faceB.openReviewOnce(review, 'pending-a')
  assert.equal(opened.length, 2)
  const { callId, ...temporary } = review
  faceA.openReviewOnce(temporary, 'unnamed-a')
  faceA.openReviewOnce(temporary, 'unnamed-b')
  faceARemounted.openReviewOnce(temporary, 'unnamed-a')
  assert.equal(opened.length, 4)
  faceA.openReview(review, 'pending-a')
  assert.equal(opened.length, 5, 'manual preview remains usable after its automatic opening')
  assert.equal(faceA.submissionCursor(), 42, 'fractional transient sequence numbers must not enter persisted stage cursors')
  entries = [{ type: 'transient', event: { seq: .5, type: 'assistant/live-chunk' } }]
  assert.equal(faceA.submissionCursor(), -1)
  await faceA.sendRevision('Revision text')
  assert.deepEqual(json(prompts), [[[ { type: 'text', text: 'Revision text' } ], 'steer']])
  dispose(); dispose()
  assert.equal(registrations.size, 0)
  assert.equal(locales, 0)
  assert.equal(dom.window.document.querySelector('style[data-plugin="qiuya-tools-plan-comments"]'), null)
})
