import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import * as storeEngine from '@deepseek-ai/dsh-client-store'

const require = createRequire(import.meta.url)
const built = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: [
    "export * from './src/features/conversation-comments/ConversationComments.tsx'",
    "export * from './src/features/conversation-comments/comments.ts'",
    "export { installConversationComments } from './src/features/conversation-comments/index.tsx'",
    "export { en } from './src/features/conversation-comments/locales.ts'",
  ].join(';'), loader: 'ts' },
  write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'test-styles', setup(builder) { builder.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default "/* conversation comments */"', loader: 'js' })) } }],
})
const module = { exports: {} }
const runtime = { module, exports: module.exports, crypto: { randomUUID }, require(id) {
  return id === '@deepseek-ai/dsh-client-store' ? storeEngine : require(id)
} }
vm.runInNewContext(built.outputFiles[0].text, runtime)
const { ConversationComments, createConversationCommentsStore, installConversationComments, en } = module.exports
const translate = (key, params) => en[key].replace(/\{(\w+)\}/gu, (_, name) => String(params?.[name]))
const json = value => JSON.parse(JSON.stringify(value))
const rectangle = { left: 20, top: 40, right: 160, bottom: 60, width: 140, height: 20, x: 20, y: 40, toJSON() { return {} } }

async function fixture(t, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><main data-slot="main.conversation"><div data-chat-flow>${['a', 'b'].map(key => `<div data-chat-flow-kind="assistant-step" data-chat-node-key="${key}"><div data-slot="conversation.chat.node" style="display:contents"><div><div><div class="MarkdownText_markdown_hash"><p>Repeat <strong>this text</strong> here.</p></div></div></div></div></div>`).join('')}</div><div data-composer-card><div id="app"></div></div></main></body></html>`, { url: 'https://conversation.test/' })
  const previous = new Map()
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {}, IS_REACT_ACT_ENVIRONMENT: true }
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    runtime[name] = value
  }
  runtime.localStorage = dom.window.localStorage
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => rectangle
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 500 })
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle]
  const store = createConversationCommentsStore().create('chat-a')
  const input = { draft: 'Keep my @file reference', draftRev: 7, phase: 'plain', attachmentIds: ['attachment-a'], occurrences: [{ source: 'files', ref: 'file-a', offset: 8, length: 5 }] }
  const session = { openState: 'open', removed: false, subagent: null }
  const nodes = new Map(['a', 'b'].map(key => [key, { key, kind: 'assistant-step', visibility: 'visible', data: {
    status: 'settled', blocks: [{ kind: 'text', text: 'Repeat **this text** here.' }], finalNode: { messageId: `message-${key}` },
  } }]))
  const snapshot = { nodes: { get: key => nodes.get(key) } }
  const calls = { send: [], insert: [], question: [], persist: 0, watched: 0, stopped: 0 }
  let confirm
  const props = {
    sessionId: 'chat-a', t: translate, useChat: select => select(snapshot), useInput: select => select(input), useSession: select => select(session),
    useStore: selector => useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()), () => selector(store.getSnapshot())), actions: store.actions,
    inputActions: { insertText(text, span) {
      calls.insert.push([text, span])
      const detectEnd = input.draft.length - input.occurrences.reduce((sum, occurrence) => sum + occurrence.length - 1, 0)
      if (options.insertRefused || span.draftRev !== input.draftRev || span.start !== detectEnd || span.end !== span.start) return false
      input.draft += text; input.draftRev++
      return true
    }, persistDraft() { calls.persist++ }, setDraft() { assert.fail('Must preserve structured reference chips') }, submit() { assert.fail('Adding comments must not send automatically') } },
    watchSubmitted: callback => { calls.watched++; confirm = callback; return () => { calls.stopped++ } },
    submissionCursor: () => 100,
    sendComments: async text => { calls.send.push(text); return options.send ? options.send(text) : null },
    openQuestion: async quote => { calls.question.push(quote); await options.question?.(quote) },
  }
  const root = createRoot(dom.window.document.querySelector('#app'))
  let unmounted = false
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => { root.unmount(); await setImmediate() }) } }
  t.after(async () => {
    await unmount()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
      delete runtime[name]
    }
    delete runtime.localStorage
    dom.window.close()
  })
  await act(async () => { root.render(React.createElement(ConversationComments, props)); await setImmediate() })
  const document = dom.window.document
  const button = label => [...document.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent).trim() === label)
  const click = async label => { const target = button(label); assert.ok(target, `Missing button ${label}`); await act(async () => { target.click(); await setImmediate() }) }
  const markdown = key => document.querySelector(`[data-chat-node-key="${key}"] .MarkdownText_markdown_hash`)
  const select = async (key = 'a') => {
    const text = markdown(key).querySelector('strong').firstChild
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.length)
    dom.window.getSelection().removeAllRanges(); dom.window.getSelection().addRange(range)
    await act(async () => { markdown(key).dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true })); await setImmediate() })
  }
  const change = async value => { await act(async () => { const textarea = document.querySelector('textarea'); textarea.value = value; Simulate.change(textarea); await setImmediate() }) }
  const save = async (note = 'Explain this more clearly', key = 'a') => { await select(key); await click('Add comment'); await change(note); await click('Save comment') }
  return { dom, document, props, store, input, session, nodes, calls, button, click, markdown, select, change, save, unmount,
    confirm: async (text, seq) => { await act(async () => { confirm(text, seq); await setImmediate() }) },
    rerender: async () => { await act(async () => { root.render(React.createElement(ConversationComments, { ...props })); await setImmediate() }) },
  }
}

test('selecting text creates a persistent numbered comment with hover, editing and deletion', async t => {
  const f = await fixture(t)
  await f.select()
  assert.ok(f.button('Add comment'))
  await f.click('Add comment')
  assert.equal(f.document.querySelector('[role="dialog"] blockquote').textContent, 'this text')
  assert.equal(f.button('Save comment').disabled, true)
  await f.change('Please explain this phrase')
  await f.click('Save comment')
  const [comment] = f.store.getSnapshot().comments
  assert.equal(comment.quote, 'this text')
  assert.equal(comment.note, 'Please explain this phrase')
  assert.equal(comment.messageId, 'message-a')
  assert.equal(comment.contentId, 'text:0')
  assert.equal(f.document.querySelector('[role="dialog"]'), null)
  const marker = f.document.querySelector('[data-qyt-cc-number]')
  assert.equal(marker.textContent, '1')
  await act(async () => { Simulate.mouseEnter(marker); await setImmediate() })
  assert.equal(f.document.querySelector('[role="tooltip"]').textContent, comment.note)
  await act(async () => { marker.click(); await setImmediate() })
  await f.change('Updated request')
  await f.click('Save comment')
  assert.equal(f.store.getSnapshot().comments[0].id, comment.id)
  assert.equal(f.store.getSnapshot().comments[0].note, 'Updated request')
  await act(async () => { f.document.querySelector('[data-qyt-cc-number]').click(); await setImmediate() })
  await f.click('Delete comment')
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.document.querySelector('[data-qyt-cc-number]'), null)
  assert.equal(f.document.querySelector('.qyt-cc-chip'), null)
})

test('Ask in new chat passes only the selected passage to the new-conversation action and preserves the current draft', async t => {
  const f = await fixture(t)
  const before = json(f.input)
  await f.select('b')
  assert.ok(f.button('Add comment'))
  await f.click('Ask in new chat')
  assert.deepEqual(f.calls.question, ['this text'])
  assert.deepEqual(json(f.input), before)
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.calls.insert.length, 0)
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.document.querySelector('[data-qyt-cc-floating]'), null)
})

test('failed new-chat preparation keeps the selection action available for a deliberate retry', async t => {
  let attempts = 0
  const f = await fixture(t, { question: async () => { if (++attempts === 1) throw Error('New-chat preparation failed') } })
  await f.select()
  await f.click('Ask in new chat')
  assert.ok(f.document.querySelector('[data-qyt-cc-floating] [role="status"]'))
  assert.equal(f.button('Ask in new chat').disabled, false)
  await f.click('Ask in new chat')
  assert.equal(f.calls.question.length, 2)
  assert.equal(f.document.querySelector('[data-qyt-cc-floating]'), null)
  assert.equal(f.calls.send.length, 0)
})

test('identical quoted text in separate replies stays attached to its own message and shares one summary', async t => {
  const f = await fixture(t)
  await f.save('First reply request', 'a')
  await f.save('Second reply request', 'b')
  assert.deepEqual(Array.from(f.store.getSnapshot().comments, value => value.messageId), ['message-a', 'message-b'])
  assert.equal(f.markdown('a').querySelector('[data-qyt-cc-number]').textContent, '1')
  assert.equal(f.markdown('b').querySelector('[data-qyt-cc-number]').textContent, '2')
  await f.click('▤ 2 comments')
  assert.equal(f.document.querySelectorAll('[data-qyt-cc-item]').length, 2)
  assert.match(f.document.querySelector('.qyt-cc-panel').textContent, /First reply request.*Second reply request/su)
  await act(async () => { f.document.querySelector('[data-qyt-cc-item] [aria-label="Delete comment"]').click(); await setImmediate() })
  assert.equal(f.markdown('a').querySelector('[data-qyt-cc-number]'), null)
  assert.equal(f.markdown('b').querySelector('[data-qyt-cc-number]').textContent, '1')
})

test('add to composer appends with a revision guard, preserves existing draft, refs and attachments, and waits for its receipt', async t => {
  const f = await fixture(t)
  const before = json(f.input)
  await f.save()
  await f.click('▤ 1 comments')
  await f.click('Add to composer')
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.calls.persist, 1)
  const detectEnd = before.draft.length - (before.occurrences[0].length - 1)
  assert.deepEqual(json(f.calls.insert[0][1]), { start: detectEnd, end: detectEnd, draftRev: before.draftRev })
  assert.ok(f.input.draft.startsWith(`${before.draft}\n\nConversation comment submission：`))
  assert.match(f.input.draft, /> this text\nRequested change：Explain this more clearly/u)
  assert.deepEqual(json(f.input.occurrences), before.occurrences)
  assert.deepEqual(json(f.input.attachmentIds), before.attachmentIds)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.store.getSnapshot().staged[0].match, 'includes')
  await f.confirm(f.input.draft, 100)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  await f.confirm(`${f.input.draft}\nExtra final instruction`, 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.store.getSnapshot().staged.length, 0)
})

test('refused composer insertion retains the comment and removes only the attempted staging', async t => {
  const f = await fixture(t, { insertRefused: true })
  const before = json(f.input)
  await f.save(); await f.click('▤ 1 comments'); await f.click('Add to composer')
  assert.deepEqual(json(f.input), before)
  assert.equal(f.calls.persist, 0)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.store.getSnapshot().staged.length, 0)
  assert.match(f.document.querySelector('[role="status"]').textContent, /composer changed/u)
})

test('an inserted annotation block cannot be inserted or submitted twice while its unique marker remains in the draft', async t => {
  const f = await fixture(t)
  const original = f.input.draft
  await f.save(); await f.click('▤ 1 comments'); await f.click('Add to composer')
  const firstDraft = f.input.draft
  await f.click('▤ 1 comments')
  assert.equal(f.button('Add to composer').disabled, true)
  assert.equal(f.button('Submit comments').disabled, true)
  assert.equal(f.button('Edit comment').disabled, true)
  assert.equal(f.button('Delete comment').disabled, true)
  await f.click('Edit comment'); await f.click('Delete comment')
  await act(async () => { f.document.querySelector('[data-qyt-cc-number]').click(); await setImmediate() })
  assert.equal(f.document.querySelector('[role="dialog"]'), null)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  await f.click('Add to composer'); await f.click('Submit comments')
  assert.equal(f.calls.insert.length, 1)
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.input.draft, firstDraft)
  assert.match(f.document.querySelector('[role="status"]').textContent, /added to the composer/u)

  f.input.draft = `${original}\nAdditional draft wording`
  f.input.draftRev++
  await f.rerender()
  assert.equal(f.button('Add to composer').disabled, false)
  assert.equal(f.button('Submit comments').disabled, false)
  assert.equal(f.button('Edit comment').disabled, false)
  assert.equal(f.button('Delete comment').disabled, false)
  await f.click('Edit comment')
  assert.ok(f.document.querySelector('[role="dialog"]'))
  await f.change('Updated after removing the old batch')
  await f.click('Save comment')
  await f.click('Add to composer')
  assert.equal(f.calls.insert.length, 2)
  assert.ok(f.input.draft.startsWith(`${original}\nAdditional draft wording\n\n`))
  assert.match(f.input.draft, /Updated after removing the old batch/u)
  assert.equal(f.calls.send.length, 0)
})

test('direct submission preserves the full draft and clears only after durable confirmation', async t => {
  const f = await fixture(t)
  const before = json(f.input)
  await f.save(); await f.click('▤ 1 comments'); await f.click('Submit comments')
  assert.deepEqual(json(f.input), before)
  assert.equal(f.calls.insert.length, 0)
  assert.equal(f.calls.send.length, 1)
  assert.match(f.calls.send[0], /Quoted reply：\n> this text/u)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.button('Submit comments').disabled, true)
  assert.equal(f.button('Edit comment').disabled, true)
  assert.equal(f.button('Delete comment').disabled, true)
  await f.click('Edit comment'); await f.click('Delete comment')
  await act(async () => { f.document.querySelector('[data-qyt-cc-number]').click(); await setImmediate() })
  assert.equal(f.document.querySelector('[role="dialog"]'), null)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  await f.confirm(f.calls.send[0], 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.document.querySelector('.qyt-cc-chip'), null)
})

test('definite refusal retains editable comments and permits one deliberate retry', async t => {
  let attempts = 0
  const f = await fixture(t, { send: async () => ++attempts === 1 ? 'Host refused this request' : null })
  await f.save(); await f.click('▤ 1 comments'); await f.click('Submit comments')
  assert.equal(f.store.getSnapshot().staged.length, 0)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.button('Submit comments').disabled, false)
  assert.equal(f.button('Edit comment').disabled, false)
  assert.equal(f.button('Delete comment').disabled, false)
  assert.equal(f.document.querySelector('[role="status"]').textContent, 'Host refused this request')
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 2)
  assert.equal(f.store.getSnapshot().staged.length, 1)
})

test('unconfirmed submission remains staged and cannot be sent again until reconciled', async t => {
  const f = await fixture(t, { send: async () => { throw Error('Connection lost after admission') } })
  await f.save(); await f.click('▤ 1 comments'); await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.store.getSnapshot().staged.length, 1)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.button('Submit comments').disabled, true)
  assert.equal(f.button('Add to composer').disabled, true)
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
  await f.confirm(f.calls.send[0], 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
})

test('unmount removes message overlays, floating editor and the durable receipt subscription', async t => {
  const f = await fixture(t)
  await f.save(); await f.select('b'); await f.click('Add comment')
  assert.equal(f.document.querySelectorAll('[data-qyt-cc-layer]').length, 2)
  assert.ok(f.document.querySelector('[data-qyt-cc-floating]'))
  await f.unmount()
  assert.equal(f.calls.watched, 1)
  assert.equal(f.calls.stopped, 1)
  assert.equal(f.document.querySelector('[data-qyt-cc-layer]'), null)
  assert.equal(f.document.querySelector('[data-qyt-cc-root]'), null)
  assert.equal(f.document.querySelector('[data-qyt-cc-floating]'), null)
  await act(async () => { f.markdown('b').dispatchEvent(new f.dom.window.MouseEvent('pointerup', { bubbles: true })); await setImmediate() })
  assert.equal(f.document.querySelector('[data-qyt-cc-floating]'), null)
})

test('installation binds the requested session generation, watches its receipts and disposes its slot, locale and styles', async t => {
  const f = await fixture(t)
  const calls = { prompts: [], locales: 0, slots: 0, watchers: 0 }
  const entries = [{ type: 'event', event: { seq: 24, type: 'assistant/message' } }]
  const binding = { eventSource: {
    getSnapshot: () => ({ revision: 0, entries }), subscribe: () => () => { calls.watchers++ },
  }, session: { async prompt(content, mode) { calls.prompts.push([content, mode]); return { ok: true } } } }
  let current = binding
  let registration
  const ctx = { locale: { register(namespace) {
    assert.equal(namespace, 'qiuyaConversationComments'); return () => { calls.locales++ }
  } }, sessions: { binding(id) { assert.equal(id, 'requested-session'); return current } }, slots: {
    inject(name, callback) { assert.equal(name, 'conversation.input.dock'); return callback() },
    register(options, Component) { registration = options; assert.equal(Component, ConversationComments); return () => { calls.slots++ } },
  } }
  const dispose = installConversationComments(ctx)
  assert.equal(f.document.querySelectorAll('style[data-qyt-conversation-comments]').length, 1)
  const injected = registration.inject('requested-session')
  assert.equal(injected.submissionCursor(), 24)
  const stop = injected.watchSubmitted(() => {})
  assert.equal(await injected.sendComments('Only these comments'), null)
  assert.deepEqual(json(calls.prompts), [[[{ type: 'text', text: 'Only these comments' }], 'queue']])
  current = { ...binding }
  assert.equal(typeof await injected.sendComments('Must not enter a replacement session'), 'string')
  assert.equal(calls.prompts.length, 1)
  stop(); dispose()
  assert.equal(calls.watchers, 1)
  assert.equal(calls.locales, 1)
  assert.equal(calls.slots, 1)
  assert.equal(f.document.querySelector('style[data-qyt-conversation-comments]'), null)
})
