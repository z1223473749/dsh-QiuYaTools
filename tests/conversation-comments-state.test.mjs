import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const built = await build({ entryPoints: ['src/features/conversation-comments/comments.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
const runtime = { module, exports: module.exports, require }
vm.runInNewContext(built.outputFiles[0].text, runtime)
const { createConversationCommentsStore, conversationCommentsPrompt, locateConversationComment } = module.exports
const json = value => JSON.parse(JSON.stringify(value))
const comment = { id: 'comment-a', messageId: 'message-1', contentId: 'text-0', quote: 'Read the store', note: 'Check whether it already exists.', start: 0, end: 14, prefix: '', suffix: ' before editing.' }
const key = session => `qiuyaTools.conversation-comments.v1.${session}`

function storage(t) {
  const values = new Map()
  runtime.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  t.after(() => { delete runtime.localStorage })
  return values
}

test('annotations survive reopening only in their own session and transient sending state does not persist', t => {
  storage(t)
  const handle = createConversationCommentsStore()
  const first = handle.create('session-a')
  first.actions.save(comment)
  first.actions.setSending(true)
  first.actions.setMissing([comment.id])
  first.actions.stage('Exact submitted prompt', [comment.id], 100)
  const reopened = handle.create('session-a').getSnapshot()
  assert.deepEqual(json(reopened.comments), [comment])
  assert.equal(reopened.staged[0].draft, 'Exact submitted prompt')
  assert.equal(reopened.sending, false)
  assert.deepEqual(json(reopened.missing), [])
  assert.deepEqual(json(handle.create('session-b').getSnapshot().comments), [])
})

test('receipt requires exact delivered text and a later event; newly added comments remain', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  store.actions.save(comment)
  store.actions.stage('Prompt plus draft', [comment.id], 100)
  const later = { ...comment, id: 'later', messageId: 'message-2' }
  store.actions.save(later)
  for (const [text, seq] of [['Prompt', 101], ['Prefix Prompt plus draft Suffix', 101], ['Prompt plus draft', 100], ['Prompt plus draft', 99]]) store.actions.confirmSubmitted(text, seq)
  assert.equal(store.getSnapshot().comments.length, 2)
  store.actions.confirmSubmitted('Prompt plus draft', 101)
  assert.deepEqual(json(store.getSnapshot().comments), [later])
  assert.equal(store.getSnapshot().staged.length, 0)
})

test('a complete marked annotation block confirms inside a larger serialized draft after reopening', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  const block = '[QiuYaTools annotation 50b38101-59b0-4ee3-a3f7-3b71a04720b7]\n' + conversationCommentsPrompt([comment])
  store.actions.save(comment)
  store.actions.stage(block, [comment.id], 10, 'includes')
  const reopened = createConversationCommentsStore().create('session')
  assert.equal(reopened.getSnapshot().staged[0].match, 'includes')
  reopened.actions.confirmSubmitted('Existing draft and file reference\n\n' + block + '\nAdditional request.', 11)
  assert.deepEqual(json(reopened.getSnapshot().comments), [])
  assert.equal(reopened.getSnapshot().staged.length, 0)
})

test('marked block receipts preserve annotations for partial blocks, missing unique markers, and old event sequences', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  const prompt = conversationCommentsPrompt([comment])
  const marker = '[QiuYaTools annotation 50b38101-59b0-4ee3-a3f7-3b71a04720b7]'
  const block = marker + '\n' + prompt
  store.actions.save(comment)
  store.actions.stage(block, [comment.id], 10, 'includes')
  for (const [text, seq] of [[prompt, 11], [marker + '\n' + prompt.slice(0, -1), 11], ['Prefix\n' + block + '\nSuffix', 10], [block, 9]]) {
    store.actions.confirmSubmitted(text, seq)
    assert.deepEqual(json(store.getSnapshot().comments), [comment])
    assert.equal(store.getSnapshot().staged.length, 1)
  }
})

test('editing then restoring a note after submission cannot let the old receipt discard the new edit', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  store.actions.save(comment)
  store.actions.stage('Submitted', [comment.id], 1)
  store.actions.save({ ...comment, note: 'New idea' })
  store.actions.save(comment)
  const reopened = createConversationCommentsStore().create('session')
  reopened.actions.confirmSubmitted('Submitted', 2)
  assert.deepEqual(json(reopened.getSnapshot().comments), [comment])
  assert.equal(reopened.getSnapshot().staged.length, 0)
})

test('deleting and recreating the same comment identity during a send preserves the replacement', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  store.actions.save(comment)
  store.actions.stage('Submitted', [comment.id], 1)
  store.actions.remove([comment.id])
  store.actions.save(comment)
  store.actions.confirmSubmitted('Submitted', 2)
  assert.deepEqual(json(store.getSnapshot().comments), [comment])
})

test('failed send removes only its staging record and leaves comments and another submission intact', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  store.actions.save(comment)
  store.actions.stage('First send', [comment.id], 1)
  store.actions.stage('Second send', [comment.id], 2)
  store.actions.unstage('First send')
  assert.deepEqual(json(store.getSnapshot().comments), [comment])
  assert.deepEqual(json(store.getSnapshot().staged.map(item => item.draft)), ['Second send'])
})

test('messages and content blocks with identical text retain independent notes and numbering order', t => {
  storage(t)
  const store = createConversationCommentsStore().create('session')
  const second = { ...comment, id: 'comment-b', contentId: 'text-1', note: 'Other block request' }
  const third = { ...comment, id: 'comment-c', messageId: 'message-2', note: 'Other reply request' }
  store.actions.save(comment)
  store.actions.save(second)
  store.actions.save(third)
  store.actions.remove([second.id])
  assert.deepEqual(json(store.getSnapshot().comments), [comment, third])
})

test('malformed persisted anchors, duplicate ids, and invalid receipts are rejected without blocking valid notes', t => {
  const values = storage(t)
  values.set(key('session'), JSON.stringify({ comments: [comment, comment,
    { ...comment, id: 'bad-offset', end: 8 }, { ...comment, id: 'no-message', messageId: '' },
    { ...comment, id: 'blank', note: ' ' }, { ...comment, id: 'fractional', start: .1 },
  ], revisions: { [comment.id]: 3, bad: -1 }, staged: [
    { draft: 'Accepted', ids: [comment.id], revisions: { [comment.id]: 3 }, afterSeq: 8 },
    { draft: 'Broken', ids: [comment.id], revisions: { [comment.id]: -1 }, afterSeq: 8 },
    { draft: 'Invalid match mode', ids: [comment.id], revisions: { [comment.id]: 3 }, afterSeq: 8, match: 'prefix' },
  ] }))
  const store = createConversationCommentsStore().create('session')
  assert.deepEqual(json(store.getSnapshot().comments), [comment])
  assert.equal(store.getSnapshot().staged.length, 1)
  store.actions.confirmSubmitted('Accepted', 9)
  assert.deepEqual(json(store.getSnapshot().comments), [])
})

test('broken JSON and denied storage retain usable in-memory editing', t => {
  const values = storage(t)
  values.set(key('session'), '{broken')
  assert.deepEqual(json(createConversationCommentsStore().create('session').getSnapshot().comments), [])
  runtime.localStorage = { getItem() { throw Error('denied') }, setItem() { throw Error('quota') }, removeItem() { throw Error('denied') } }
  const store = createConversationCommentsStore().create('session')
  assert.doesNotThrow(() => { store.actions.save(comment); store.clearPersisted() })
  assert.deepEqual(json(store.getSnapshot().comments), [comment])
})

test('source anchors move with unique text and remain unresolved when repeated text has no unique context', () => {
  assert.deepEqual(json(locateConversationComment('Intro. Read the store before editing.', comment)), { start: 7, end: 21 })
  assert.equal(locateConversationComment('Read the store then Read the store.', { ...comment, start: 100, end: 114, prefix: undefined, suffix: undefined }), undefined)
  const anchored = { ...comment, start: 100, end: 114, prefix: 'then ', suffix: '.' }
  assert.deepEqual(json(locateConversationComment('Read the store then Read the store.', anchored)), { start: 20, end: 34 })
  assert.equal(locateConversationComment('The source was removed.', comment), undefined)
})

test('submission prompt pairs multiline original quotes with notes and supports both locales', () => {
  const multiline = { ...comment, quote: 'First line\nSecond line', note: '  Explain both.  ' }
  const zh = conversationCommentsPrompt([multiline])
  assert.match(zh, /1\. 引用原文：\n> First line\n> Second line\n修改意见：Explain both\./)
  assert.match(conversationCommentsPrompt([comment], 'en'), /Quoted reply：[\s\S]*Requested change：Check whether it already exists\./)
  assert.equal(conversationCommentsPrompt([]), '')
})
