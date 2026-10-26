import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)

// This runs in a separate Node process with no development dependencies.
// In particular, do not import Schemastery or Cordis into this clean room:
// a real installed bundle must supply its own Host runtime dependencies.
const probe = `
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

await assert.rejects(access(join(process.cwd(), 'node_modules')), { code: 'ENOENT' })
const host = await import(pathToFileURL(process.argv[1]).href)
assert.equal(typeof host.Config, 'function')
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host.Config.simplify, 'function')

const expected = {
  enabled: true,
  pastedTextEnabled: true,
  sessionWindowsEnabled: true,
  bulkArchiveEnabled: true,
  planCommentsEnabled: true,
  conversationCommentsEnabled: true,
  sidebarToolsEnabled: true,
  promptSuggestionsEnabled: true,
  qThemeEnabled: false,
  computerUseEnabled: true,
  pasteCharacterThreshold: 1000,
  pasteLineThreshold: 15,
}
const standard = host.Config['~standard']
assert.ok(standard, 'the bundled schema must implement the official Standard Schema interface')
assert.equal(standard.version, 1)
assert.equal(typeof standard.vendor, 'string')
assert.equal(typeof standard.validate, 'function')

const unwrap = value => Object.fromEntries(Object.entries(value).map(([field, ref]) => [field, ref.get()]))
const validated = standard.validate({})
assert.equal(typeof validated.then, 'undefined', 'Cordis requires synchronous configuration validation')
assert.equal(validated.issues, undefined, 'default configuration must validate')
for (const [field, value] of Object.entries(expected)) {
  assert.equal(typeof validated.value[field].get, 'function', field + ' must remain volatile')
  assert.equal(validated.value[field].get(), value, field + ' must preserve its default')
}
assert.equal(host.Config.simplify(validated.value), null, 'default-valued fields are omitted from persistence')
assert.deepEqual(unwrap(host.Config({})), expected,
  'callable Config and Standard Schema must agree')

for (const input of [
  { pasteCharacterThreshold: 1, pasteLineThreshold: 1 },
  { pasteCharacterThreshold: 1_000_000, pasteLineThreshold: 100_000 },
  { enabled: false, promptSuggestionsEnabled: false, qThemeEnabled: true },
]) {
  const result = await standard.validate(input)
  assert.equal(result.issues, undefined, 'valid boundary or explicit settings must validate')
  assert.deepEqual(unwrap(result.value), { ...expected, ...input })
  const plain = host.Config.simplify(result.value)
  assert.deepEqual(plain, input)
  const restored = await standard.validate(JSON.parse(JSON.stringify(plain)))
  assert.equal(restored.issues, undefined)
  assert.deepEqual(unwrap(restored.value), { ...expected, ...input },
    'plain persisted data must restore volatile references and omitted defaults')
  for (const [field, value] of Object.entries(input)) assert.equal(result.value[field].get(), value)
}

const invalid = [
  { pasteCharacterThreshold: 0 },
  { pasteCharacterThreshold: -1 },
  { pasteCharacterThreshold: 1_000_001 },
  { pasteCharacterThreshold: 1.5 },
  { pasteCharacterThreshold: '1000' },
  { pasteCharacterThreshold: NaN },
  { pasteCharacterThreshold: Infinity },
  { pasteLineThreshold: 0 },
  { pasteLineThreshold: -1 },
  { pasteLineThreshold: 100_001 },
  { pasteLineThreshold: 1.5 },
  { pasteLineThreshold: '15' },
  { enabled: 'false' },
  { promptSuggestionsEnabled: 'true' },
]
for (const input of invalid) {
  const result = await standard.validate(input)
  assert.ok(result.issues?.length > 0, 'invalid settings must report Standard Schema issues')
}

const owner = {}
const injections = []
const cleanups = []
let settingsOwner
let settingsOptions
let configured = false
host.apply({
  fiber: owner,
  inject(services, callback) {
    injections.push([...services])
    if (!services.includes('settings')) return
    callback({
      effect(effect) { cleanups.push(effect()) },
      settings: {
        configure(options, fiber) {
          configured = true; settingsOwner = fiber; settingsOptions = options
          return () => { configured = false }
        },
      },
    })
  },
}, validated.value)
assert.deepEqual(injections, [
  ['connection', 'webServer'], ['connection'], ['settings'], ['connection', 'webServer'],
  ['connection', 'llm', 'sessions', 'sessionProjections', 'agentDefaultModel'],
])
assert.equal(settingsOwner, owner)
assert.deepEqual(settingsOptions, { auto: false })
assert.equal(configured, true)
for (const cleanup of cleanups.reverse()) cleanup()
assert.equal(configured, false)

console.log(JSON.stringify({ imported: true, standardSchema: true, volatileFields: Object.keys(expected).length, invalidCases: invalid.length, applied: true }))
`

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

async function isolatedHost(t) {
  const cleanRoom = await mkdtemp(join(tmpdir(), 'qiuya-host-package-'))
  t.after(() => rm(cleanRoom, { recursive: true, force: true }))
  const [projectPath, isolatedPath] = await Promise.all([realpath(fileURLToPath(root)), realpath(cleanRoom)])
  assert.equal(isInside(projectPath, isolatedPath), false, 'the clean room must be outside the repository')
  for (let parent = isolatedPath; ; parent = dirname(parent)) {
    assert.notEqual(parent, projectPath, 'module resolution must never reach the project dependencies')
    if (parent === dirname(parent)) break
  }
  await mkdir(join(cleanRoom, 'lib'))
  await copyFile(new URL('lib/index.js', root), join(cleanRoom, 'lib', 'index.js'))
  await writeFile(join(cleanRoom, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  return { cleanRoom, hostPath: resolve(cleanRoom, 'lib', 'index.js') }
}

test('the installed Host imports and validates settings with no project node_modules available', async t => {
  const { cleanRoom, hostPath } = await isolatedHost(t)
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const child = spawnSync(process.execPath, [
    '--input-type=module', '--eval', probe, hostPath,
  ], {
    cwd: cleanRoom,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', INIT_CWD: cleanRoom, PWD: cleanRoom },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, [
    'Packaged Host failed in a clean installation: ' + pkg.name + '@' + pkg.version,
    child.stdout, child.stderr,
  ].filter(Boolean).join('\n'))
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    imported: true, standardSchema: true, volatileFields: 12, invalidCases: 14, applied: true,
  })
})

test('the bundled schema activates through real Cordis and preserves the shared volatile protocol', async t => {
  // Development copies are used only as compatibility consumers in this parent
  // process. The clean-room child above never receives these package paths.
  const [{ Context }, { isVolatile }] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@deepseek-ai/cosmokit'),
  ])
  const { hostPath } = await isolatedHost(t)
  const host = await import(pathToFileURL(hostPath).href)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const overrides = new Map()
  ctx.provide('settings', {
    configure(options, fiber) {
      overrides.set(fiber, options)
      return () => overrides.delete(fiber)
    },
  })
  const fiber = await ctx.plugin(host, {
    enabled: false, pasteCharacterThreshold: 1200, pasteLineThreshold: 20,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(overrides.get(fiber), { auto: false }, 'real dependency injection must execute Host apply')
  assert.equal(fiber.config.enabled.get(), false)
  assert.equal(fiber.config.pasteCharacterThreshold.get(), 1200)
  assert.equal(fiber.config.pasteLineThreshold.get(), 20)
  assert.equal(fiber.config.promptSuggestionsEnabled.get(), true)
  assert.equal(fiber.config.qThemeEnabled.get(), false)
  assert.equal(Object.keys(fiber.config).length, 12)
  assert.equal(fiber.config.conversationCommentsEnabled.get(), true)
  for (const [field, value] of Object.entries(fiber.config)) {
    assert.equal(isVolatile(value), true, field + ' must be recognized across bundled and Host library copies')
  }
  assert.deepEqual(host.Config.simplify(fiber.config), {
    enabled: false, pasteCharacterThreshold: 1200, pasteLineThreshold: 20,
  })
  await assert.rejects(async () => { await ctx.plugin(host, { pasteCharacterThreshold: 0 }) }, /invalid config/i)
  assert.equal(overrides.size, 1, 'invalid configuration must not activate another Host instance')
  await fiber.dispose()
  assert.equal(overrides.size, 0, 'real Cordis disposal must release the settings override')
})
