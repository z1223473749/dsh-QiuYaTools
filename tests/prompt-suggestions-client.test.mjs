import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = new URL('../', import.meta.url)
const compiled = (await build({
  entryPoints: [new URL('src/features/prompt-suggestions/client.ts', root).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
})).outputFiles[0].text
const css = await readFile(new URL('src/features/prompt-suggestions/styles.css', root), 'utf8')
const settle = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

// Control just the controller's timers and Date.now; DOM focus, selection,
// mutation observation and dispatched events remain real JSDOM behavior.
function clock() {
  let now = 1000
  let nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(callback, delay = 0) {
      const id = ++nextId
      timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(amount) {
      const target = now + amount
      let calls = 0
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        assert.ok(++calls < 100, 'timers must not loop without making progress')
        timers.delete(next[0]); now = next[1].at; next[1].callback()
      }
      now = target
    },
    clear() { timers.clear() },
    size: () => timers.size,
  }
}

function fixture(t, { state: patch = {}, beforeInstall, debounceMs = 1 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><style>
    [data-composer-placeholder] { visibility: visible; }
    ${css}
  </style></head><body><main data-slot="main.conversation"><section data-phase="active">
    <form><div data-composer-card><div data-input-scroll><div data-grow>
      <div data-composer-input contenteditable="true" role="textbox" tabindex="0"></div>
      <div data-composer-placeholder>发送消息或创建任务</div>
    </div></div></div></form>
    <button id="outside" type="button">其他控件</button>
  </section></main></body></html>`, { url: 'https://harness.test/' })
  const { document: doc } = dom.window
  const card = doc.querySelector('[data-composer-card]')
  const form = doc.querySelector('form')
  const outside = doc.getElementById('outside')
  const time = clock()
  dom.window.setTimeout = (...args) => time.setTimeout(...args)
  dom.window.clearTimeout = id => time.clearTimeout(id)
  let focused = true
  let visibility = 'visible'
  doc.hasFocus = () => focused
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => visibility })
  card.getClientRects = () => [new dom.window.DOMRect(0, 0, 640, 120)]
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, AbortController, queueMicrotask,
    Date: { now: () => time.now() },
  })
  const state = {
    sessionId: 'session-one', contextKey: 'assistant-turn-one', language: 'zh',
    ready: true, draft: '', draftRev: 1, phase: 'plain', attachmentCount: 0, occurrenceCount: 0,
    ...patch,
  }
  const requests = []
  const canceled = []
  const inserted = []
  const forbidden = []
  const controllers = []
  let capture = () => ({ start: 0, end: 0, draftRev: state.draftRev })
  let insert = () => true
  let requestId = 0
  let nativeMenuOpen = false
  let submits = 0
  form.addEventListener('submit', event => { submits++; event.preventDefault() })
  const options = {
    read: () => ({ ...state }),
    captureInsertion: () => capture(),
    insertText(text, span) { inserted.push({ text, span: { ...span } }); return insert(text, span) },
    request(payload, signal) {
      const reply = deferred()
      requests.push({ payload: { ...payload }, signal, ...reply })
      return reply.promise
    },
    cancel: async id => { canceled.push(id) },
    createRequestId: () => `request-${++requestId}`,
    debounceMs,
    nativeMenuOpen: () => nativeMenuOpen,
    send: () => forbidden.push('send'),
    setDraft: () => forbidden.push('setDraft'),
  }
  const f = {
    dom, doc, card, outside, state, requests, canceled, inserted, forbidden, time,
    get editor() { return card.querySelector('[data-composer-input]') },
    get grow() { return this.editor?.parentElement },
    get placeholder() { return card.querySelector('[data-composer-placeholder]') },
    get controller() { return controllers.at(-1) },
    get submits() { return submits },
    install() {
      const controller = module.exports.attachPromptSuggestion(card, options)
      controllers.push(controller)
      return controller
    },
    setCapture(value) { capture = value },
    setInsert(value) { insert = value },
    nativeMenu(value, sync = true) { nativeMenuOpen = value; if (sync) this.controller?.sync() },
    selectEditor() {
      const range = doc.createRange()
      range.selectNodeContents(this.editor); range.collapse(false)
      const selection = doc.getSelection()
      selection.removeAllRanges(); selection.addRange(range)
      doc.dispatchEvent(new dom.window.Event('selectionchange'))
    },
    focusEditor() { this.editor.focus(); this.selectEditor() },
    update(value) { Object.assign(state, value); this.controller?.sync() },
    key(key, init = {}, target = this.editor) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(event)
      return event
    },
    input(text, patch = {}) {
      state.draft = text; state.draftRev++; Object.assign(state, patch)
      this.editor.textContent = text; this.selectEditor()
      this.editor.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    },
    composition(type) { this.editor.dispatchEvent(new dom.window.CompositionEvent(type, { bubbles: true })) },
    windowFocus(value) {
      focused = value
      dom.window.dispatchEvent(new dom.window.Event(value ? 'focus' : 'blur'))
    },
    visibility(value) { visibility = value; doc.dispatchEvent(new dom.window.Event('visibilitychange')) },
    ghost() { return card.querySelector('.qyt-prompt-suggestion') },
    visible() { return this.ghost() !== null && !this.ghost().hidden },
    placeholderVisible() { return dom.window.getComputedStyle(this.placeholder).visibility === 'visible' },
    async tick(amount = 0) {
      await settle(); time.advance(amount); await settle()
      time.advance(0); await settle()
    },
    async reply(index = requests.length - 1, suggestion = '可以先列出实现步骤吗？') {
      requests[index].resolve({ suggestion, anchorMessageId: `anchor-${index}` })
      await settle()
    },
    async show(suggestion) {
      await this.tick(debounceMs)
      assert.equal(requests.length, 1)
      await this.reply(0, suggestion)
      assert.equal(this.visible(), true)
    },
  }
  f.focusEditor()
  beforeInstall?.(f)
  f.install()
  t.after(() => {
    for (const controller of controllers.reverse()) controller.dispose()
    time.clear(); dom.window.close()
  })
  return f
}

function portalMenu(f, { role = 'menu', laidOut = true, parent = f.doc.body, hidden = false, ariaHidden = false } = {}) {
  const menu = f.doc.createElement('div')
  menu.setAttribute('role', role)
  menu.hidden = hidden
  if (ariaHidden) menu.setAttribute('aria-hidden', 'true')
  menu.getClientRects = () => laidOut ? [new f.dom.window.DOMRect(0, 0, 240, 180)] : []
  parent.append(menu)
  return menu
}

test('a focused empty composer displays a safe decoration and Tab uses only the guarded insert action', async t => {
  const f = fixture(t, { debounceMs: 0 })
  assert.equal(f.placeholderVisible(), true)
  await f.show('  请解释 <b>这个方案</b> 的取舍。  ')
  assert.deepEqual(f.requests[0].payload, { sessionId: 'session-one', requestId: 'request-1', language: 'zh' })
  assert.equal(f.requests[0].signal.aborted, false)
  assert.equal(f.ghost().getAttribute('aria-hidden'), 'true')
  assert.equal(f.ghost().querySelector('b'), null, 'suggested markup is plain text, never HTML')
  assert.equal(f.ghost().querySelector('.qyt-prompt-suggestion-text').textContent, '请解释 <b>这个方案</b> 的取舍。')
  assert.match(f.card.querySelector('[aria-live="polite"]').textContent, /Tab.*Esc/)
  assert.equal(f.placeholderVisible(), false)
  let nativeKeydowns = 0
  f.doc.addEventListener('keydown', () => nativeKeydowns++)
  const event = f.key('Tab')
  assert.equal(event.defaultPrevented, true)
  assert.equal(nativeKeydowns, 0, 'a successful insertion consumes the accepting Tab')
  assert.deepEqual(f.inserted, [{ text: '请解释 <b>这个方案</b> 的取舍。', span: { start: 0, end: 0, draftRev: 1 } }])
  assert.equal(f.editor.textContent, '', 'the controller delegates insertion instead of writing editor DOM')
  assert.equal(f.state.draft, '', 'the controller never replaces the draft itself')
  assert.deepEqual(f.forbidden, [])
  assert.equal(f.submits, 0)
  await f.tick(20_000)
  f.controller.sync(); await f.tick()
  assert.equal(f.requests.length, 1)
  assert.equal(f.visible(), false)
  assert.equal(f.placeholderVisible(), true)
})

test('draft, attachment, reference and non-ready input states never request a suggestion', async t => {
  for (const [name, state] of [
    ['busy or unopened session', { ready: false }], ['typed draft', { draft: '正在输入' }],
    ['whitespace draft', { draft: ' ' }], ['attachment', { attachmentCount: 1 }],
    ['reference', { occurrenceCount: 1 }], ['command claim', { phase: 'claimed' }],
    ['submission', { phase: 'submitting' }], ['no session', { sessionId: '' }], ['no conversation context', { contextKey: '' }],
  ]) await t.test(name, async t => {
    const f = fixture(t, { state })
    await f.tick(10)
    assert.equal(f.requests.length, 0)
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
  })
})

test('native readonly, hidden, unfocused and nonempty editor surfaces remain native', async t => {
  for (const [name, beforeInstall] of [
    ['contenteditable=false', f => f.editor.setAttribute('contenteditable', 'false')],
    ['aria-disabled', f => f.editor.setAttribute('aria-disabled', 'true')],
    ['native IME marker', f => f.editor.setAttribute('data-composer-composing', '')],
    ['editor DOM contains unsynchronized text', f => { f.editor.textContent = 'native draft'; f.selectEditor() }],
    ['hidden ancestor', f => f.card.parentElement.setAttribute('hidden', '')],
    ['aria-hidden ancestor', f => f.card.parentElement.setAttribute('aria-hidden', 'true')],
    ['unlaid-out card', f => { f.card.getClientRects = () => [] }],
    ['document without focus', f => f.windowFocus(false)],
    ['background page', f => f.visibility('hidden')],
    ['another focused control', f => f.outside.focus()],
    ['detached card', f => f.card.remove()],
  ]) await t.test(name, async t => {
    const f = fixture(t, { beforeInstall })
    await f.tick(10)
    assert.equal(f.requests.length, 0)
    assert.equal(f.visible(), false)
  })
})

test('malformed, empty, long or failed helper results leave the native placeholder intact', async t => {
  for (const [name, result] of [
    ['no suggestion', null], ['empty', ''], ['whitespace', ' \t '], ['too long', '中'.repeat(121)],
    ['newline', '第一行\n第二行'], ['control character', '内容\u0000'], ['non-string', 123],
    ['zero-width space', '前\u200b后'], ['right-to-left mark', '前\u200f后'],
    ['bidi embedding', '前\u202a后'], ['bidi override', '前\u202e后'],
    ['word joiner', '前\u2060后'], ['bidi isolate', '前\u2069后'],
    ['deprecated bidi control', '前\u206f后'], ['embedded byte-order mark', '前\ufeff后'],
  ]) await t.test(name, async t => {
    const f = fixture(t)
    await f.tick(1); await f.reply(0, result)
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
    assert.deepEqual(f.inserted, [])
    assert.equal(f.key('Tab').defaultPrevented, false)
  })
  await t.test('transport rejection', async t => {
    const f = fixture(t)
    await f.tick(1)
    f.requests[0].reject(new Error('model temporarily unavailable'))
    await settle()
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
    assert.equal(f.key('Tab').defaultPrevented, false)
  })
})

test('actual input aborts pending work, rejects the late response and preserves the human draft', async t => {
  const f = fixture(t)
  await f.tick(1)
  f.input('我自己的下一条消息')
  await settle()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  await f.reply(0, '旧的建议')
  assert.equal(f.visible(), false)
  assert.equal(f.editor.textContent, '我自己的下一条消息')
  assert.equal(f.state.draft, '我自己的下一条消息')
  assert.equal(f.key('Tab').defaultPrevented, false)
  f.input(''); await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(1, '新的建议')
  assert.equal(f.visible(), true)
})

test('attachments, references, busy state and readonly changes withdraw an already visible suggestion', async t => {
  for (const [name, change] of [
    ['attachment added', f => f.update({ attachmentCount: 1 })],
    ['reference added', f => f.update({ occurrenceCount: 1 })],
    ['session starts running', f => f.update({ ready: false })],
    ['input claim starts', f => f.update({ phase: 'claimed' })],
    ['readonly attribute changes', f => f.editor.setAttribute('contenteditable', 'false')],
  ]) await t.test(name, async t => {
    const f = fixture(t); await f.show()
    change(f); await settle()
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
    assert.equal(f.key('Tab').defaultPrevented, false)
    assert.deepEqual(f.inserted, [])
  })
})

test('stale draft revisions, invalid insertion spans and changed selections never consume Tab', async t => {
  for (const [name, change] of [
    ['stale revision', f => f.setCapture(() => ({ start: 0, end: 0, draftRev: f.state.draftRev - 1 }))],
    ['nonzero span', f => f.setCapture(() => ({ start: 1, end: 1, draftRev: f.state.draftRev }))],
    ['capture unavailable', f => f.setCapture(() => { throw new Error('editor changed') })],
    ['selection moved outside the editor', f => {
      const range = f.doc.createRange(); range.selectNodeContents(f.outside); range.collapse(true)
      f.doc.getSelection().removeAllRanges(); f.doc.getSelection().addRange(range)
    }],
    ['selection is no longer collapsed', f => {
      const range = f.doc.createRange(); range.setStart(f.editor, 0); range.setEnd(f.outside.firstChild, 1)
      f.doc.getSelection().removeAllRanges(); f.doc.getSelection().addRange(range)
    }],
  ]) await t.test(name, async t => {
    const f = fixture(t); await f.show()
    change(f)
    assert.equal(f.key('Tab').defaultPrevented, false)
    assert.deepEqual(f.inserted, [])
    assert.deepEqual(f.forbidden, [])
  })
})

test('a rejected or throwing public insertion leaves Tab available to native navigation', async t => {
  for (const [name, insert] of [
    ['rejected', () => false], ['throws', () => { throw new Error('stale editor') }],
  ]) await t.test(name, async t => {
    const f = fixture(t); await f.show()
    f.setInsert(insert)
    const event = f.key('Tab')
    assert.equal(event.defaultPrevented, false)
    assert.equal(f.inserted.length, 1)
    assert.deepEqual(f.forbidden, [])
    assert.equal(f.state.draft, '')
    await settle()
    f.controller.sync(); await f.tick(15_001)
    assert.equal(f.visible(), false, 'a refusal cannot immediately resurrect through the mutation observer')
    assert.equal(f.requests.length, 1)
  })
})

test('the insertion span is checked again after the eligibility read without swallowing stale Tab presses', async t => {
  for (const failure of ['revision', 'throw']) await t.test(failure, async t => {
    const f = fixture(t); await f.show()
    let captures = 0
    f.setCapture(() => {
      captures++
      if (captures === 2 && failure === 'throw') throw new Error('editor changed during key handling')
      return { start: 0, end: 0, draftRev: f.state.draftRev - (captures === 2 ? 1 : 0) }
    })
    assert.equal(f.key('Tab').defaultPrevented, false)
    assert.equal(captures, 2)
    assert.deepEqual(f.inserted, [])
    await settle()
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
  })
})

test('native menus and native keyboard handlers take precedence over suggestion acceptance', async t => {
  for (const marker of ['data-trigger-menu', 'data-popup-select', 'role']) await t.test(marker, async t => {
    const f = fixture(t); await f.show()
    const menu = f.doc.createElement('div'); menu.setAttribute(marker, marker === 'role' ? 'listbox' : '')
    f.card.append(menu)
    assert.equal(f.key('Tab').defaultPrevented, false)
    assert.deepEqual(f.inserted, [])
    await settle()
    assert.equal(f.visible(), false)
  })
  await t.test('native preventDefault', async t => {
    const f = fixture(t); await f.show()
    f.editor.addEventListener('keydown', event => event.preventDefault(), { once: true })
    assert.equal(f.key('Tab').defaultPrevented, true)
    assert.deepEqual(f.inserted, [])
  })
  await t.test('native trigger state before its menu DOM is painted', async t => {
    const f = fixture(t); await f.show()
    f.nativeMenu(true, false)
    assert.equal(f.key('Tab').defaultPrevented, false)
    assert.deepEqual(f.inserted, [])
    assert.equal(f.visible(), false)
  })
})

test('portaled native menus immediately keep Tab native and restore the cached suggestion after closing', async t => {
  for (const role of ['menu', 'dialog', 'alertdialog']) await t.test(role, async t => {
    const f = fixture(t); await f.show()
    const menu = portalMenu(f, { role })
    assert.equal(f.doc.activeElement, f.editor, 'a portal can open without moving native editor focus')
    assert.equal(f.key('Tab').defaultPrevented, false, 'keydown rechecks the portal before MutationObserver runs')
    assert.deepEqual(f.inserted, [])
    await settle()
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
    menu.remove(); await settle()
    assert.equal(f.visible(), true, 'closing the portal restores the same eligible conversation context')
    assert.equal(f.requests.length, 1, 'a cached suggestion does not spend another model request')
    assert.equal(f.key('Tab').defaultPrevented, true)
    assert.equal(f.inserted.length, 1)
  })
})

test('a portaled menu cancels pending work and its stale completion cannot appear', async t => {
  const f = fixture(t); await f.tick(1)
  const menu = portalMenu(f)
  await settle()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  assert.equal(f.doc.activeElement, f.editor)
  await f.reply(0, '打开菜单前的旧建议')
  assert.equal(f.visible(), false)
  assert.equal(f.key('Tab').defaultPrevented, false)
  menu.remove(); await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(1, '关闭菜单后的建议')
  assert.equal(f.visible(), true)
  assert.equal(f.key('Tab').defaultPrevented, true)
  assert.deepEqual(f.inserted.map(value => value.text), ['关闭菜单后的建议'])
})

test('an already open portaled dialog prevents a helper request until it closes', async t => {
  let menu
  const f = fixture(t, { beforeInstall(value) { menu = portalMenu(value, { role: 'dialog' }) } })
  await f.tick(20)
  assert.equal(f.requests.length, 0)
  assert.equal(f.visible(), false)
  menu.remove(); await f.tick(1)
  assert.equal(f.requests.length, 1)
  await f.reply()
  assert.equal(f.visible(), true)
})

test('hidden or unlaid-out portal menus do not suppress an otherwise eligible composer', async t => {
  for (const [name, options, ancestorAttribute] of [
    ['hidden menu', { hidden: true }],
    ['aria-hidden menu', { ariaHidden: true }],
    ['unlaid-out menu', { laidOut: false }],
    ['hidden ancestor', {}, ['hidden', '']],
    ['aria-hidden ancestor', {}, ['aria-hidden', 'true']],
  ]) await t.test(name, async t => {
    const f = fixture(t, { beforeInstall(value) {
      let parent = value.doc.body
      if (ancestorAttribute) {
        parent = value.doc.createElement('div')
        parent.setAttribute(...ancestorAttribute)
        value.doc.body.append(parent)
      }
      portalMenu(value, { ...options, parent })
    } })
    await f.show()
    assert.equal(f.key('Tab').defaultPrevented, true)
    assert.equal(f.inserted.length, 1)
  })
})

test('portal visibility attribute changes hide and restore suggestions without any focus change', async t => {
  for (const attribute of ['hidden', 'aria-hidden']) await t.test(attribute, async t => {
    const f = fixture(t)
    const parent = f.doc.createElement('div')
    parent.setAttribute(attribute, attribute === 'hidden' ? '' : 'true')
    f.doc.body.append(parent)
    portalMenu(f, { parent })
    await f.show()
    parent.removeAttribute(attribute); await settle()
    assert.equal(f.visible(), false)
    assert.equal(f.placeholderVisible(), true)
    assert.equal(f.key('Tab').defaultPrevented, false)
    parent.setAttribute(attribute, attribute === 'hidden' ? '' : 'true'); await settle()
    assert.equal(f.visible(), true)
    assert.equal(f.requests.length, 1)
    assert.equal(f.doc.activeElement, f.editor)
  })
})

test('expanded native model triggers win even when their portaled panel uses role=group', async t => {
  for (const attribute of ['aria-haspopup', 'aria-controls']) await t.test(attribute, async t => {
    const f = fixture(t)
    const trigger = f.doc.createElement('button')
    trigger.setAttribute(attribute, attribute === 'aria-haspopup' ? 'menu' : 'native-model-panel')
    trigger.setAttribute('aria-expanded', 'false')
    f.card.append(trigger)
    const menu = portalMenu(f, { role: 'group' }); menu.id = 'native-model-panel'
    await f.show()
    trigger.setAttribute('aria-expanded', 'true')
    assert.equal(f.key('Tab').defaultPrevented, false, 'an expanded trigger is checked before its observer callback')
    assert.deepEqual(f.inserted, [])
    await settle()
    assert.equal(f.visible(), false)
    trigger.setAttribute('aria-expanded', 'false'); await settle()
    assert.equal(f.visible(), true)
    assert.equal(f.requests.length, 1)
    assert.equal(f.key('Tab').defaultPrevented, true)
  })
})

test('expanding a native model trigger cancels a pending helper and closing it permits a fresh request', async t => {
  const f = fixture(t)
  const trigger = f.doc.createElement('button')
  trigger.setAttribute('aria-controls', 'native-model-panel')
  trigger.setAttribute('aria-expanded', 'false')
  f.card.append(trigger)
  portalMenu(f, { role: 'group' }).id = 'native-model-panel'
  await f.tick(1)
  trigger.setAttribute('aria-expanded', 'true'); await settle()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  await f.reply(0, '展开菜单之前的旧建议')
  assert.equal(f.visible(), false)
  trigger.removeAttribute('aria-expanded'); await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(1, '关闭菜单后的新建议')
  assert.equal(f.visible(), true)
})

test('modified, repeated, composing and noncancelable keys keep their native behavior', async t => {
  const f = fixture(t); await f.show()
  for (const [key, init] of [
    ['Tab', { shiftKey: true }], ['Tab', { ctrlKey: true }], ['Tab', { altKey: true }],
    ['Tab', { metaKey: true }], ['Tab', { repeat: true }], ['Tab', { isComposing: true }],
    ['Tab', { keyCode: 229 }], ['Tab', { cancelable: false }], ['Enter', {}],
    ['Escape', { shiftKey: true }], ['Escape', { repeat: true }],
  ]) assert.equal(f.key(key, init).defaultPrevented, false, `${key}: ${JSON.stringify(init)}`)
  assert.deepEqual(f.inserted, [])
  assert.equal(f.visible(), true)
  assert.equal(f.key('Tab', {}, f.outside).defaultPrevented, false)
  assert.deepEqual(f.forbidden, [])
})

test('Escape dismisses just the current conversation context without accepting or retrying it', async t => {
  const f = fixture(t); await f.show()
  assert.equal(f.key('Escape').defaultPrevented, true)
  assert.equal(f.visible(), false)
  assert.equal(f.placeholderVisible(), true)
  f.controller.sync(); f.doc.dispatchEvent(new f.dom.window.Event('selectionchange'))
  await f.tick(20_000); f.controller.sync(); await f.tick(1)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.inserted, [])
  f.update({ contextKey: 'assistant-turn-two' }); await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(1, '新的回复之后可以出现')
  assert.equal(f.visible(), true)
})

test('IME composition hides suggestions and enforces the post-composition guard before Tab can accept', async t => {
  const f = fixture(t); await f.show()
  f.composition('compositionstart')
  assert.equal(f.visible(), false)
  assert.equal(f.key('Tab', { isComposing: true }).defaultPrevented, false)
  assert.equal(f.key('Tab', { keyCode: 229 }).defaultPrevented, false)
  f.composition('compositionend')
  assert.equal(f.key('Tab').defaultPrevented, false)
  await f.tick(9)
  assert.equal(f.key('Tab').defaultPrevented, false)
  await f.tick(1)
  assert.equal(f.visible(), false, 'the scheduled restoration waits until after the 10ms guard')
  await f.tick(1)
  assert.equal(f.visible(), true)
  assert.equal(f.key('Tab').defaultPrevented, true)
  assert.equal(f.inserted.length, 1)
})

test('IME starting during a request aborts it and ignores its late result', async t => {
  const f = fixture(t)
  await f.tick(1)
  f.composition('compositionstart')
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  await f.reply(0, '合成开始前的旧建议')
  assert.equal(f.visible(), false)
  f.composition('compositionend')
  await f.tick(12)
  assert.equal(f.requests.length, 2)
  await f.reply(1, '合成结束后的建议')
  assert.equal(f.visible(), true)
})

test('blur and hidden documents cancel pending work and never display its stale completion', async t => {
  for (const [name, leave, returnToEditor] of [
    ['window blur', f => f.windowFocus(false), f => f.windowFocus(true)],
    ['focusout to another control', f => f.outside.focus(), f => f.focusEditor()],
    ['page hidden', f => f.visibility('hidden'), f => f.visibility('visible')],
  ]) await t.test(name, async t => {
    const f = fixture(t); await f.tick(1)
    leave(f); await settle()
    assert.equal(f.requests[0].signal.aborted, true)
    assert.deepEqual(f.canceled, ['request-1'])
    await f.reply(0, '离开之前的结果')
    assert.equal(f.visible(), false)
    returnToEditor(f); await f.tick(1)
    assert.equal(f.requests.length, 2)
    await f.reply(1, '重新聚焦的结果')
    assert.equal(f.visible(), true)
  })
})

test('switching session, conversation context or language aborts and discards the old request', async t => {
  for (const patch of [{ sessionId: 'session-two' }, { contextKey: 'assistant-turn-two' }, { language: 'en' }]) await t.test(Object.keys(patch)[0], async t => {
    const f = fixture(t); await f.tick(1)
    f.update(patch)
    assert.equal(f.requests[0].signal.aborted, true)
    assert.deepEqual(f.canceled, ['request-1'])
    await f.tick(1)
    assert.equal(f.requests.length, 2)
    await f.reply(0, 'stale suggestion')
    assert.equal(f.visible(), false)
    await f.reply(1, 'current suggestion')
    assert.equal(f.visible(), true)
    assert.equal(f.ghost().querySelector('.qyt-prompt-suggestion-text').textContent, 'current suggestion')
    if (patch.language) assert.match(f.card.querySelector('[aria-live]').textContent, /^Suggestion:.*Escape/)
  })
})

test('context changes before the debounce avoid starting the obsolete model request', async t => {
  const f = fixture(t)
  f.update({ sessionId: 'session-two', contextKey: 'turn-two' })
  await f.tick(1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].payload.sessionId, 'session-two')
  assert.deepEqual(f.canceled, [], 'an unstarted debounce has no remote request to cancel')
})

test('a failed or empty context is throttled until the retry interval or a new context', async t => {
  const f = fixture(t)
  await f.tick(1); await f.reply(0, null)
  for (let i = 0; i < 3; i++) { f.controller.sync(); await f.tick(1) }
  assert.equal(f.requests.length, 1)
  await f.tick(15_000); f.controller.sync(); await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(1, null)
  f.update({ contextKey: 'next-turn' }); await f.tick(1)
  assert.equal(f.requests.length, 3)
})

test('disposal cancels pending work and removes decorations, listeners and placeholder suppression', async t => {
  const f = fixture(t); await f.tick(1)
  f.controller.dispose(); f.controller.dispose()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  await f.reply(0, 'too late')
  assert.equal(f.ghost(), null)
  assert.equal(f.card.querySelector('[aria-live]'), null)
  assert.equal(f.grow.hasAttribute('data-qyt-prompt-visible'), false)
  assert.equal(f.placeholderVisible(), true)
  f.input(''); f.doc.dispatchEvent(new f.dom.window.Event('selectionchange')); f.windowFocus(true)
  await f.tick(100)
  assert.equal(f.requests.length, 1)
  assert.equal(f.time.size(), 0)
  assert.equal(f.key('Tab').defaultPrevented, false)
})

test('reinstalling on one card replaces its owner without duplicate requests or keyboard insertion', async t => {
  const f = fixture(t); await f.tick(1)
  const old = f.controller
  f.install()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.canceled, ['request-1'])
  await f.tick(1)
  assert.equal(f.requests.length, 2)
  await f.reply(0, 'old owner')
  assert.equal(f.visible(), false)
  await f.reply(1, 'replacement owner')
  old.dispose()
  assert.equal(f.card.querySelectorAll('.qyt-prompt-suggestion').length, 1)
  assert.equal(f.card.querySelectorAll('[aria-live]').length, 1)
  assert.equal(f.visible(), true)
  assert.equal(f.key('Tab').defaultPrevented, true)
  assert.equal(f.inserted.length, 1)
  f.controller.dispose()
  assert.equal(f.ghost(), null)
  assert.equal(f.placeholderVisible(), true)
})

test('removing a displayed owner restores the original placeholder and leaves no helper DOM', async t => {
  const f = fixture(t); await f.show()
  const placeholder = f.placeholder
  const originalText = placeholder.textContent
  assert.equal(f.placeholderVisible(), false)
  f.controller.dispose()
  assert.equal(f.placeholder, placeholder)
  assert.equal(placeholder.textContent, originalText)
  assert.equal(f.placeholderVisible(), true)
  assert.equal(f.card.querySelector('.qyt-prompt-suggestion-sr'), null)
  assert.equal(f.grow.hasAttribute('data-qyt-prompt-visible'), false)
})
