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
import { Context } from '@deepseek-ai/cordis'
import * as storeEngine from '@deepseek-ai/dsh-client-store'

const require = createRequire(import.meta.url)
const built = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: [
    "export * from './src/features/conversation-comments/ConversationComments.tsx'",
    "export * from './src/features/conversation-comments/comments.ts'",
    "export * from './src/features/conversation-comments/composer-reference.ts'",
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
const { ConversationComments, createConversationCommentsStore, installConversationComments, installConversationCommentReferences, en, conversationCommentSource, conversationCommentReferenceText, createConversationCommentReferenceSource } = module.exports
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
  const calls = { send: [], insert: [], references: [], question: [], persist: 0, watched: 0, stopped: 0 }
  let confirm, openReference
  const clipboardOffset = index => {
    let delta = 0
    for (const occurrence of input.occurrences) { if (occurrence.offset - delta >= index) break; delta += occurrence.length - 1 }
    return index + delta
  }
  const props = {
    sessionId: 'chat-a', t: translate, useChat: select => select(snapshot), useInput: select => select(input), useSession: select => select(session),
    useStore: selector => useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()), () => selector(store.getSnapshot())), actions: store.actions,
    inputActions: { captureInsertion() { const end = input.draft.length - input.occurrences.reduce((sum, occurrence) => sum + occurrence.length - 1, 0); return { start: end, end, draftRev: input.draftRev } }, insertText(text, span) {
      calls.insert.push([text, span])
      if (options.automatic && span.draftRev === input.draftRev) {
        const start = clipboardOffset(span.start), end = clipboardOffset(span.end)
        input.draft = input.draft.slice(0, start) + text + input.draft.slice(end)
        input.occurrences = input.occurrences.filter(item => item.offset < start || item.offset >= end)
          .map(item => item.offset >= end ? { ...item, offset: item.offset + text.length - (end - start) } : item)
        input.draftRev++; return true
      }
      const detectEnd = input.draft.length - input.occurrences.reduce((sum, occurrence) => sum + occurrence.length - 1, 0)
      if (options.insertRefused || span.draftRev !== input.draftRev || span.start !== detectEnd || span.end !== span.start) return false
      input.draft += text; input.draftRev++
      return true
    }, persistDraft() { calls.persist++ }, setDraft() { assert.fail('Must preserve structured reference chips') }, submit() { assert.fail('Adding comments must not send automatically') } },
    watchSubmitted: callback => { calls.watched++; confirm = callback; return () => { calls.stopped++ } },
    submissionCursor: () => 100,
    sendComments: async text => { calls.send.push(text); return options.send ? options.send(text) : null },
    openQuestion: async quote => { calls.question.push(quote); await options.question?.(quote) },
    ...options.automatic ? {
      watchOpenReference(callback) { openReference = callback; return () => { openReference = undefined } },
      insertReference(text, count, span) {
        calls.references.push([text, count, json(span)])
        if (options.insertRefused || span.draftRev !== input.draftRev) return false
        const start = clipboardOffset(span.start), end = clipboardOffset(span.end)
        const clipboardText = `\n\n${text}`, tail = input.draft[end] === ' ' ? '' : ' '
        const length = clipboardText.length + tail.length, delta = length - (end - start)
        input.draft = input.draft.slice(0, start) + clipboardText + tail + input.draft.slice(end)
        input.occurrences = [...input.occurrences.filter(item => item.offset < start || item.offset >= end)
          .map(item => item.offset >= end ? { ...item, offset: item.offset + delta } : item),
          { source: conversationCommentSource('chat-a'), ref: module.exports.conversationCommentReference('chat-a', text, `${count} comments`).ref,
            offset: start, length: clipboardText.length, clipboardText, label: `${count} comments`, occurrenceId: 99 }].sort((a, b) => a.offset - b.offset)
        input.draftRev++; return true
      },
    } : {},
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
    openComments: async () => { await act(async () => { assert.ok(openReference); openReference(); await setImmediate() }) },
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

test('saving automatically stages one native composer chip and leaves the surrounding draft, reference and attachment intact', async t => {
  const f = await fixture(t, { automatic: true })
  const before = json(f.input)
  await f.save()
  assert.equal(f.calls.send.length, 0)
  assert.equal(f.calls.insert.length, 0)
  assert.equal(f.calls.references.length, 1)
  assert.equal(f.calls.references[0][1], 1)
  assert.deepEqual(f.calls.references[0][2], { start: before.draft.length - 4, end: before.draft.length - 4, draftRev: before.draftRev })
  assert.ok(f.input.draft.startsWith(`${before.draft}\n\n`))
  assert.deepEqual(json(f.input.occurrences[0]), before.occurrences[0])
  assert.deepEqual(json(f.input.attachmentIds), before.attachmentIds)
  const [reference] = f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a'))
  assert.equal(reference.label, '1 comments')
  assert.match(conversationCommentReferenceText(reference.ref, 'chat-a'), /Requested change：Explain this more clearly/u)
  assert.ok(f.document.querySelector('[data-composer-card] [data-qyt-conversation-comments]'))
  assert.equal(f.document.querySelector('.qyt-cc-chip'), null, 'The native editor chip is the single count control')
  await f.rerender()
  assert.equal(f.calls.references.length, 1)
  await f.openComments()
  assert.equal(f.button('Edit comment').disabled, false)
  assert.equal(f.button('Add to composer').disabled, true)
  assert.equal(f.button('Submit comments').disabled, false, 'Separate submission remains available')
})

test('separate submission removes only its automatic chip, preserves draft attachments and restores the chip after a definite refusal', async t => {
  let attempts = 0
  const f = await fixture(t, { automatic: true, send: async () => ++attempts === 1 ? 'Refused' : null })
  const original = json(f.input)
  await f.save(); await f.openComments(); await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a')).length, 1)
  assert.deepEqual(json(f.input.occurrences[0]), original.occurrences[0])
  assert.deepEqual(json(f.input.attachmentIds), original.attachmentIds)
  assert.equal(f.button('Submit comments').disabled, false)
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 2)
  assert.equal(f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a')).length, 0)
  assert.equal(f.input.draft.trimEnd(), original.draft)
  assert.deepEqual(json(f.input.occurrences[0]), original.occurrences[0])
  assert.deepEqual(json(f.input.attachmentIds), original.attachmentIds)
  assert.equal(f.button('Submit comments').disabled, true)
  await f.confirm(f.calls.send[1], 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.store.getSnapshot().staged.length, 0)
  assert.equal(f.input.draft.trimEnd(), original.draft)
})

test('an unconfirmed separate submission keeps its chip out of the next message and retains its pending notes', async t => {
  const f = await fixture(t, { automatic: true, send: async () => { throw Error('Transport ended without a result') } })
  await f.save(); await f.openComments(); await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
  assert.equal(f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a')).length, 0)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.store.getSnapshot().staged.length, 1)
  assert.equal(f.store.getSnapshot().staged[0].match, 'exact')
  assert.equal(f.button('Submit comments').disabled, true)
  await f.rerender()
  assert.equal(f.calls.references.length, 1)
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
  await f.confirm(f.calls.send[0], 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
})

test('a refused automatic chip insertion preserves the original draft, references, attachments and editable comments', async t => {
  const f = await fixture(t, { automatic: true, insertRefused: true }), original = json(f.input)
  await f.save()
  assert.deepEqual(json(f.input), original)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.store.getSnapshot().staged.length, 0)
  assert.equal(f.calls.persist, 0)
  await f.click('▤ 1 comments')
  assert.equal(f.button('Edit comment').disabled, false)
})

test('editing and deleting auto-attached comments replaces only their own chip and confirms only the sent revision', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  const old = f.calls.references[0][0]
  const file = json(f.input.occurrences[0])
  await f.openComments(); await f.click('Edit comment'); await f.change('New wording'); await f.click('Save comment')
  assert.equal(f.calls.references.length, 2)
  assert.equal(f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a')).length, 1)
  assert.equal(f.input.draft.includes(old), false)
  assert.deepEqual(json(f.input.occurrences[0]), file)
  await f.confirm(old, 101)
  assert.equal(f.store.getSnapshot().comments.length, 1, 'An old receipt must not clear an edited comment')
  await f.click('Delete comment')
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.input.occurrences.filter(item => item.source === conversationCommentSource('chat-a')).length, 0)
  assert.deepEqual(json(f.input.occurrences[0]), file)
  assert.deepEqual(json(f.input.attachmentIds), ['attachment-a'])
  assert.equal(f.input.draft.trimEnd(), 'Keep my @file reference')
})

test('optimistic send does not reinsert a staged batch and a failed-send restoration keeps its original chip and comments', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  const snapshot = json(f.input), text = f.calls.references[0][0]
  f.input.draft = ''; f.input.occurrences = []; f.input.attachmentIds = []; f.input.draftRev++
  f.session.pendingSubmissions = [{ text: snapshot.draft }]
  await f.rerender()
  assert.equal(f.calls.references.length, 1)
  assert.equal(f.store.getSnapshot().comments.length, 1)
  await f.click('▤ 1 comments')
  assert.equal(f.button('Submit comments').disabled, true, 'Optimistic clear must not permit the same batch to be sent separately')
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 0)
  f.session.pendingSubmissions = []
  Object.assign(f.input, { ...snapshot, draftRev: f.input.draftRev + 1 })
  await f.rerender()
  assert.equal(f.calls.references.length, 1, 'Restoring a failed send does not create a duplicate chip')
  assert.equal(f.input.draft, snapshot.draft)
  assert.deepEqual(json(f.input.attachmentIds), snapshot.attachmentIds)
  assert.equal(f.button('Submit comments').disabled, false, 'A restored failed draft remains deliberately retryable')
  f.input.draft = ''; f.input.occurrences = []; f.input.attachmentIds = []; f.input.draftRev++
  await f.rerender(); await f.confirm(`Original user text\n\n${text}`, 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
  assert.equal(f.store.getSnapshot().staged.length, 0)
  assert.equal(f.calls.references.length, 1)
})

test('failed ordinary submission with a newer draft releases the public pending fence without replacing new text', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  const text = f.calls.references[0][0]
  f.input.draft = ''; f.input.occurrences = []; f.input.draftRev++
  f.session.pendingSubmissions = [{ text }]
  await f.rerender(); await f.click('▤ 1 comments')
  assert.equal(f.button('Submit comments').disabled, true)
  f.input.draft = 'New draft entered while send was pending'; f.input.draftRev++
  f.session.pendingSubmissions = []; f.session.promptError = { op: 'send', error: { message: 'Definite refusal' } }
  await f.rerender()
  assert.equal(f.input.draft, 'New draft entered while send was pending')
  assert.equal(f.store.getSnapshot().comments.length, 1)
  assert.equal(f.button('Submit comments').disabled, false)
  assert.equal(f.button('Edit comment').disabled, false)
  assert.equal(f.calls.references.length, 1)
})

test('a preceding reference serialization failure cannot create an unobservable permanent comment lock', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  f.input.draft = 'New draft after another reference failed'; f.input.occurrences = []; f.input.draftRev++
  await f.rerender(); await f.click('▤ 1 comments')
  assert.equal(f.button('Edit comment').disabled, false)
  assert.equal(f.button('Submit comments').disabled, false)
  assert.equal(f.input.draft, 'New draft after another reference failed')
  assert.equal(f.store.getSnapshot().comments.length, 1)
})

test('deliberately deleting an unsent native chip does not create a permanent pending lock', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  f.input.draft = 'Keep my @file reference'; f.input.occurrences = [f.input.occurrences[0]]; f.input.draftRev++
  await f.rerender(); await f.click('▤ 1 comments')
  assert.equal(f.button('Submit comments').disabled, false)
  assert.equal(f.button('Edit comment').disabled, false)
  await f.click('Submit comments')
  assert.equal(f.calls.send.length, 1)
})

test('public pending echoes and queued messages keep a restored annotation batch from being separately resent', async t => {
  const f = await fixture(t, { automatic: true })
  await f.save()
  const text = f.calls.references[0][0]
  f.input.draft = ''; f.input.occurrences = []; f.input.draftRev++
  f.session.pendingSubmissions = [{ text: `User wording\n\n${text}` }]
  await f.rerender(); await f.click('▤ 1 comments')
  assert.equal(f.button('Submit comments').disabled, true)
  f.session.pendingSubmissions = []
  f.input.queue = [{ role: 'user', content: [{ type: 'text', text }] }]
  await f.rerender()
  assert.equal(f.button('Submit comments').disabled, true)
  await f.confirm(text, 101)
  assert.equal(f.store.getSnapshot().comments.length, 0)
})

test('native comment codec rejects foreign conversation references, cancelled attempts and inactive sessions', async () => {
  const reference = module.exports.conversationCommentReference('chat-a', 'Receipt\nRequested comment', '1 comments')
  let current = true, opened = 0
  const source = createConversationCommentReferenceSource(sessionId => current && sessionId === 'chat-a', () => { opened++; return true })
  assert.deepEqual(json(await source.candidates()), [])
  assert.equal(await source.codec.serialize(reference.ref, new AbortController().signal), reference.clipboardText)
  assert.equal(source.openReference({ sessionId: 'chat-b' }, reference), false)
  assert.equal(source.openReference({ sessionId: 'chat-a' }, reference), true)
  assert.equal(opened, 1)
  const foreign = module.exports.conversationCommentReference('chat-b', 'Foreign text', '1 comments')
  await assert.rejects(source.codec.serialize(foreign.ref, new AbortController().signal), /conversation changed/u)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(source.codec.serialize(reference.ref, abort.signal), { name: 'AbortError' })
  current = false
  await assert.rejects(source.codec.serialize(reference.ref, new AbortController().signal), /conversation changed/u)
  assert.equal(source.openReference({ sessionId: 'chat-a' }, reference), false)
})

test('the real Cordis codec owner survives sibling UI disable and decodes restored drafts without that UI', async () => {
  const root = new Context(), sources = new Map()
  let current = 'chat-a', binding = {}, removed = 0, opened = 0
  const provider = root.plugin({ name: 'comment-codec-test-services', apply(ctx) {
    ctx.provide('inputTriggers', { registerSource(source) { assert.equal(sources.has(source.name), false); sources.set(source.name, source); return () => { removed++; sources.delete(source.name) } } })
    ctx.provide('sessions', { binding: id => id === current ? binding : undefined })
    ctx.provide('uiSession', { adapter: { current: { getSnapshot: () => ({ key: current }) } } })
  } })
  await provider.await()
  const owner = root.plugin({ name: 'comment-codec-test-owner', inject: ['inputTriggers', 'sessions', 'uiSession'], apply(ctx) { ctx.effect(() => installConversationCommentReferences(ctx)) } })
  await owner.await()
  const source = sources.get(conversationCommentSource('chat-a'))
  const reference = module.exports.conversationCommentReference('chat-a', 'Persisted draft comment', '1 comment')
  assert.equal(await source.codec.serialize(reference.ref, new AbortController().signal), reference.clipboardText, 'A restored draft works before any feature UI starts')
  const captured = binding
  const ui = root.plugin({ name: 'comment-codec-test-ui', inject: ['qiuyaConversationCommentReferences'], apply(ctx) {
    ctx.effect(() => ctx.get('qiuyaConversationCommentReferences').watchOpen('chat-a', () => binding === captured, () => { opened++ }))
  } })
  await ui.await()
  assert.equal(source.openReference({ sessionId: 'chat-a' }, reference), true)
  assert.equal(opened, 1)
  await ui.dispose()
  assert.equal(removed, 0)
  assert.equal(await source.codec.serialize(reference.ref, new AbortController().signal), reference.clipboardText)
  assert.equal(source.openReference({ sessionId: 'chat-a' }, reference), false)
  current = 'chat-b'
  await assert.rejects(source.codec.serialize(reference.ref, new AbortController().signal), /conversation changed/u)
  current = 'chat-a'; binding = {}
  assert.equal(await source.codec.serialize(reference.ref, new AbortController().signal), reference.clipboardText, 'Reconnection preserves the same logical conversation draft')
  await owner.dispose(); assert.equal(removed, 1); assert.equal(root.get('qiuyaConversationCommentReferences'), undefined)
  await provider.dispose()
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
  const calls = { prompts: [], locales: 0, slots: 0, watchers: 0, sources: [], sourceDisposals: 0, references: [] }
  const entries = [{ type: 'event', event: { seq: 24, type: 'assistant/message' } }]
  const binding = { eventSource: {
    getSnapshot: () => ({ revision: 0, entries }), subscribe: () => () => { calls.watchers++ },
  }, ctx: { bail(_scope, event, request) { assert.equal(event, 'slash/input-insert-reference'); calls.references.push(request); return true } },
  session: { async prompt(content, mode) { calls.prompts.push([content, mode]); return { ok: true } } } }
  let current = binding
  let registration
  const services = { inputTriggers: { registerSource(source) { calls.sources.push(source); return () => { calls.sourceDisposals++ } } } }
  const ctx = { get(name) { return services[name] }, provide(name, value) { services[name] = value; return () => { delete services[name] } },
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'requested-session' }) } } }, locale: { getSnapshot: () => ({ active: 'en' }), register(namespace) {
    assert.equal(namespace, 'qiuyaConversationComments'); return () => { calls.locales++ }
  } }, sessions: { binding(id) { assert.equal(id, 'requested-session'); return current } }, slots: {
    inject(name, callback) { assert.equal(name, 'conversation.input.left'); return callback() },
    register(options, Component) { registration = options; assert.equal(Component, ConversationComments); return () => { calls.slots++ } },
  } }
  const disposeReferences = installConversationCommentReferences(ctx)
  const dispose = installConversationComments(ctx)
  assert.equal(f.document.querySelectorAll('style[data-qyt-conversation-comments]').length, 1)
  const injected = registration.inject('requested-session')
  assert.equal(calls.sources.length, 1)
  assert.equal(injected.insertReference('Receipt\nComment', 1, { start: 0, end: 0, draftRev: 2 }), true)
  assert.equal(calls.references[0].reference.label, '1 comment')
  let opened = 0
  const stopOpen = injected.watchOpenReference(() => { opened++ })
  assert.equal(calls.sources[0].openReference({ sessionId: 'requested-session' }, calls.references[0].reference), true)
  assert.equal(opened, 1)
  assert.equal(injected.submissionCursor(), 24)
  const stop = injected.watchSubmitted(() => {})
  assert.equal(await injected.sendComments('Only these comments'), null)
  assert.deepEqual(json(calls.prompts), [[[{ type: 'text', text: 'Only these comments' }], 'queue']])
  current = { ...binding }
  assert.equal(typeof await injected.sendComments('Must not enter a replacement session'), 'string')
  assert.equal(calls.prompts.length, 1)
  assert.equal(injected.insertReference('Another comment', 1, { start: 0, end: 0, draftRev: 2 }), false)
  stopOpen(); stop(); dispose()
  assert.equal(calls.watchers, 1)
  assert.equal(calls.locales, 1)
  assert.equal(calls.slots, 1)
  assert.equal(calls.sourceDisposals, 0, 'Disabling the feature UI must not remove persisted chip decoding')
  assert.equal(await calls.sources[0].codec.serialize(calls.references[0].reference.ref, new AbortController().signal), '\n\nReceipt\nComment')
  disposeReferences()
  assert.equal(calls.sourceDisposals, 1)
  assert.equal(f.document.querySelector('style[data-qyt-conversation-comments]'), null)
})
