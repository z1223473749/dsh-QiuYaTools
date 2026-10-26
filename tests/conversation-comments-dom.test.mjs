import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/conversation-comments/dom.ts', import.meta.url))],
  write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
})
const module = { exports: {} }
const runtime = { module, exports: module.exports }
vm.runInNewContext(bundle.outputFiles[0].text, runtime)
const { discoverConversationMessages, renderedConversationText, selectionConversationAnchor, conversationHighlightRanges } = module.exports

function browser(t, html) {
  const dom = new JSDOM(html)
  runtime.NodeFilter = dom.window.NodeFilter
  t.after(() => { delete runtime.NodeFilter; dom.window.close() })
  return dom.window.document
}

function node(key, overrides = {}) {
  return { key, kind: 'assistant-step', visibility: 'visible', data: {
    status: 'settled', blocks: [{ kind: 'text', text: 'Hello world' }], finalNode: { messageId: `message-${key}` },
  }, ...overrides }
}

function snapshot(...nodes) {
  const map = new Map(nodes.map(value => [value.key, value]))
  return { nodes: { get: key => map.get(key) } }
}

function row(key, children = '<div class="MarkdownText_markdown_hash"><p>Hello <strong>world</strong></p></div>', attributes = '') {
  return `<div data-chat-flow-kind="assistant-step" data-chat-node-key="${key}" ${attributes}><div data-slot="conversation.chat.node" style="display:contents"><div><div>${children}</div></div></div></div>`
}

test('matches the real renderer slot anchor and direct renderer while rejecting unrelated or nested slot seats', t => {
  const direct = '<div data-chat-flow-kind="assistant-step" data-chat-node-key="direct"><div><div><div class="markdown">Direct response</div></div></div></div>'
  const document = browser(t, `<main id="current">${row('anchored')}${direct}${row('unrelated')}${row('nested')}${row('layout')}</main>`)
  document.querySelector('[data-chat-node-key="unrelated"] > div').setAttribute('data-slot', 'unrelated.surface')
  const nested = document.querySelector('[data-chat-node-key="nested"] > div')
  nested.innerHTML = `<div data-slot="conversation.chat.node" style="display:contents">${nested.innerHTML}</div>`
  document.querySelector('[data-chat-node-key="layout"] > div').style.display = 'block'
  const content = discoverConversationMessages(document.querySelector('#current'), snapshot(node('anchored'), node('direct'), node('unrelated'), node('nested'), node('layout')))
  assert.deepEqual(Array.from(content, value => value.messageId), ['message-anchored', 'message-direct'])
})

test('discovers only the current conversation with durable assistant identity and original block indexes', t => {
  const document = browser(t, `<main data-slot="main.conversation" id="current">${row('a', '<div data-turn-process-inline><div class="markdown">Private reasoning</div></div><div class="markdown">First answer</div><div class="image">Picture</div><div class="markdown">Second answer</div>')}<aside data-slot="main.conversation">${row('nested')}</aside></main><main data-slot="main.conversation">${row('outside')}</main>`)
  const content = discoverConversationMessages(document.querySelector('#current'), snapshot(node('a', { data: {
    status: 'settled', finalNode: { messageId: 'stable-message' }, blocks: [
      { kind: 'reasoning', text: 'Private reasoning' }, { kind: 'text', text: 'First answer' },
      { kind: 'image' }, { kind: 'text', text: 'Second answer' },
    ],
  } }), node('nested'), node('outside')))
  assert.equal(content.length, 2)
  assert.deepEqual(Array.from(content, value => [value.messageId, value.contentId, value.root.textContent]), [
    ['stable-message', 'text:1', 'First answer'], ['stable-message', 'text:3', 'Second answer'],
  ])
})

test('running, synthetic, hidden, reasoning-only, nonassistant and unmatched rows never become annotation targets', t => {
  const document = browser(t, `<main id="current">${row('running')}${row('synthetic')}${row('hidden', undefined, 'hidden')}${row('reasoning', undefined, 'data-chat-group-part="reasoning"')}${row('tool')}${row('missing')}${row('streaming', undefined)}${row('invisible')}${row('valid')}</main>`)
  document.querySelector('[data-chat-node-key="streaming"] > [data-slot="conversation.chat.node"] > div').setAttribute('data-streaming', 'true')
  const content = discoverConversationMessages(document.querySelector('#current'), snapshot(
    node('running', { data: { status: 'running', blocks: [{ kind: 'text', text: 'Partial' }], finalNode: { messageId: 'wrong' } } }),
    node('synthetic', { data: { status: 'interrupted', blocks: [{ kind: 'text', text: 'Partial' }], finalNode: {} } }),
    node('hidden'), node('reasoning'), node('tool', { kind: 'tool' }), node('streaming'), node('invisible', { visibility: 'hidden' }), node('valid'),
  ))
  assert.deepEqual(Array.from(content, value => value.messageId), ['message-valid'])
})

test('ambiguous or changed host DOM fails closed without associating neighboring text', t => {
  const document = browser(t, `<main id="current">${row('extra', '<div class="markdown">One</div><div class="markdown">Extra</div>')}${row('missing', '<section><div class="markdown">Nested unrelated Markdown</div></section>')}${row('shape', '<div class="markdown">Different root</div>')}</main>`)
  document.querySelector('[data-chat-node-key="shape"]').innerHTML = '<p class="markdown">A replacement renderer</p>'
  const container = document.querySelector('#current')
  assert.equal(discoverConversationMessages(container, snapshot(node('extra'), node('missing'), node('shape'))).length, 0)
  assert.equal(discoverConversationMessages(container, undefined).length, 0)
})

test('rendered anchors span Markdown nodes, exclude code controls and cannot cross messages', t => {
  const document = browser(t, `<main id="current">${row('a', '<div class="markdown"><p>Alpha <strong>beta</strong></p><pre><div data-code-block-banner>ts<button>Copy</button></div><code>gamma</code></pre><svg><text>Icon</text></svg></div>')}${row('b')}</main>`)
  const [first, second] = discoverConversationMessages(document.querySelector('#current'), snapshot(node('a'), node('b')))
  assert.equal(renderedConversationText(first.root), 'Alpha betagamma')
  const range = document.createRange()
  range.setStart(first.root.querySelector('p').firstChild, 2)
  range.setEnd(first.root.querySelector('strong').firstChild, 4)
  const anchor = selectionConversationAnchor(first.root, range)
  assert.deepEqual(JSON.parse(JSON.stringify(anchor)), { quote: 'pha beta', start: 2, end: 10, prefix: 'Al', suffix: 'gamma' })
  assert.equal(Array.from(conversationHighlightRanges(first.root, anchor.start, anchor.end), item => item.toString()).join(''), 'pha beta')
  range.setEnd(second.root.querySelector('strong').firstChild, 2)
  assert.equal(selectionConversationAnchor(first.root, range), undefined)
  assert.equal(first.root.querySelector('strong').textContent, 'beta')
})
