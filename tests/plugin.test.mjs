import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = await import('../lib/index.js')

function loadClient() {
  const registrations = []
  const styles = new Set()
  const document = {
    createElement(tag) {
      assert.equal(tag, 'style')
      return { dataset: {}, textContent: '', remove() { styles.delete(this) } }
    },
    head: { append(style) { styles.add(style) } },
  }
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(plugin) { registrations.push(plugin) } } },
    document,
  }, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1, 'the artifact must register exactly one loader factory')
  const registration = registrations[0]
  const requestedModules = []
  const plugin = registration.factory(id => {
    requestedModules.push(id)
    if (id === 'react') return React
    if (id === 'react/jsx-runtime' || id === 'react-dom' || id === '@deepseek-ai/dsh-client-store') return require(id)
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Switch: ({ checked, disabled, label }) => React.createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, disabled, 'aria-label': label,
      }) }
    }
    throw new Error(`Client requested a module unavailable from the Harness loader: ${id}`)
  })
  return { registration, requestedModules, plugin, styles }
}

function mountClient(plugin, snapshot) {
  const cleanups = []
  const localeNamespaces = new Map()
  const sections = new Map()
  const requestedConfigIds = []
  const injectedSlots = []
  let injecting = false
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    set: async () => true,
    mutate: async () => true,
  }
  const ctx = {
    plugin() { return { dispose: async () => {} } },
    logger: { error() {} },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    locale: {
      register(namespace, messages) {
        localeNamespaces.set(namespace, messages)
        return () => localeNamespaces.delete(namespace)
      },
      bind: namespace => key => {
        assert.ok(localeNamespaces.has(namespace), 'translations must be registered before use')
        return localeNamespaces.get(namespace).zh[key]
      },
    },
    configForms: { get(id) { requestedConfigIds.push(id); return form } },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        injecting = true
        try {
          const dispose = callback()
          if (typeof dispose === 'function') cleanups.push(dispose)
        } finally {
          injecting = false
        }
      },
      register(options, component) {
        assert.equal(injecting, true, 'settings must register inside slots.inject so late slot providers work')
        sections.set(options.id, { options, component })
        return () => sections.delete(options.id)
      },
    },
  }
  plugin.apply(ctx)
  return {
    localeNamespaces, sections, requestedConfigIds, injectedSlots, form,
    dispose() { for (const cleanup of cleanups.reverse()) cleanup() },
    render() {
      const { options, component } = sections.get('qiuya-tools')
      return renderToStaticMarkup(React.createElement(component, {
        ...options.inject(),
        t: ctx.locale.bind(options.locale),
      }))
    },
  }
}

test('built client follows the Harness loader and settings contribution lifecycle', () => {
  const { registration, requestedModules, plugin, styles } = loadClient()
  assert.equal(registration.id, pkg.name)
  assert.deepEqual([...plugin.inject].sort(), ['configForms', 'connection', 'locale', 'slots'])
  assert.ok(requestedModules.includes('react'), 'React comes from the host to preserve hook identity')

  const mounted = mountClient(plugin, { status: 'ready', writable: true, value: { enabled: true } })
  assert.deepEqual(mounted.injectedSlots, ['settings.section'])
  assert.deepEqual(mounted.requestedConfigIds, ['qiuya-tools'])
  assert.equal(mounted.sections.size, 1)
  const { options } = mounted.sections.get('qiuya-tools')
  assert.equal(options.name, 'settings.section')
  assert.equal(options.label(), 'QiuYaTools')
  assert.equal(options.inject().form, mounted.form, 'settings must use the persisted host form')
  assert.equal(options.locale, 'qiuyaTools')
  const messages = mounted.localeNamespaces.get(options.locale)
  assert.equal(messages.zh.nav, 'QiuYaTools')
  assert.equal(messages.en.nav, 'QiuYaTools')
  assert.equal(messages.zh.promptSuggestionsTab, '提示词')
  assert.match(messages.zh.promptSuggestionsHint, /输入框为空.*不会自动发送/)
  assert.match(messages.zh.promptSuggestionsAccept, /Tab.*Esc/)
  assert.match(messages.zh.promptSuggestionsModel, /当前会话所选模型.*用量/)
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort())
  assert.equal(styles.size, 1)
  const [style] = styles
  assert.equal(style.dataset.plugin, pkg.name)
  assert.match(style.textContent, /\.qyt-settings/)

  mounted.dispose()
  assert.equal(mounted.sections.size, 0, 'unloading removes the settings navigation entry')
  assert.equal(mounted.localeNamespaces.size, 0, 'unloading removes translations')
  assert.equal(styles.size, 0, 'unloading removes the injected stylesheet')
})

test('settings render Chinese text and preserve access when the feature switch is off', () => {
  const { plugin } = loadClient()
  const mounted = mountClient(plugin, { status: 'ready', writable: true, value: { enabled: false } })
  try {
    const html = mounted.render()
    assert.match(html, /QiuYaTools/)
    assert.match(html, /功能设置/)
    assert.match(html, /已暂停/)
    assert.match(html, /aria-checked="false"/)
    assert.doesNotMatch(html, /<button[^>]*role="switch"[^>]*disabled/)
  } finally {
    mounted.dispose()
  }
})

test('settings cannot write before configuration loads or from a read-only connection', async t => {
  for (const [name, snapshot, feedback] of [
    ['loading', { status: 'loading', writable: false }, '正在读取配置…'],
    ['read-only', { status: 'ready', writable: false, value: { enabled: true } }, '当前连接无法保存配置。'],
    ['unavailable', { status: 'unavailable', writable: false }, '配置暂不可用'],
  ]) {
    await t.test(name, () => {
      const { plugin } = loadClient()
      const mounted = mountClient(plugin, snapshot)
      try {
        const html = mounted.render()
        assert.ok(html.includes(feedback))
        assert.match(html, /disabled=""/)
      } finally {
        mounted.dispose()
      }
    })
  }
})

test('host schema provides a volatile default and rejects string booleans', () => {
  assert.equal(host.Config({}).enabled.get(), true)
  const paused = host.Config({ enabled: false })
  assert.equal(paused.enabled.get(), false)
  assert.equal(host.Config.simplify(paused).enabled, false, 'persistence must contain plain data')
  for (const field of ['pastedTextEnabled', 'sessionWindowsEnabled', 'bulkArchiveEnabled', 'planCommentsEnabled', 'sidebarToolsEnabled', 'promptSuggestionsEnabled']) assert.equal(paused[field].get(), true)
  assert.throws(() => host.Config({ enabled: 'false' }), /boolean/i)
  assert.throws(() => host.Config({ enabled: 'true' }), /boolean/i)
  assert.throws(() => host.Config({ promptSuggestionsEnabled: 'false' }), /boolean/i)
})

test('host hides its generated form using the owner fiber and releases the override', () => {
  const fiber = {}
  const effects = []
  const overrides = new Map()
  const injections = []
  host.apply({
    fiber,
    inject(services, callback) {
      injections.push([...services])
      if (!services.includes('settings')) return
      callback({
        effect(effect) { effects.push(effect()) },
        settings: {
          configure(options, owner) {
            assert.equal(owner, fiber, 'the override must target the QiuYaTools host fiber')
            overrides.set(owner, options)
            return () => overrides.delete(owner)
          },
        },
      })
    },
  })
  assert.deepEqual(injections, [
    ['connection', 'webServer'],
    ['connection'], ['settings'], ['connection', 'webServer'],
    ['connection', 'llm', 'sessions', 'sessionProjections', 'agentDefaultModel'],
  ], 'optional update, session and suggestion services must not block registration')
  assert.deepEqual(overrides.get(fiber), { auto: false })
  for (const dispose of effects.reverse()) dispose()
  assert.equal(overrides.size, 0)
})
