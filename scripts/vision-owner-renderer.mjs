/** Generate small, credential-free probes for the existing official Desktop renderer. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const OWNER_CANDIDATE_SHA256 = '58126d4a95cb9e28962b31f4144259c315eb1a6a403478d3549ef8db343a09d2'
const root = fileURLToPath(new URL('../', import.meta.url))

// This function is serialized, never executed by the generator. Its only carrier
// is the already authenticated dsh-app renderer's ordinary same-origin Fetch.
async function ownerProbe(config) {
  const report = { kind: 'existing-owner-renderer', mode: config.mode, at: new Date().toISOString(), inferenceRequestSent: false, restarted: false, modelSelectionChanged: false }
  const emit = () => { console.log('QIUYA_OWNER_EVIDENCE ' + JSON.stringify(report)); return report }
  if (location.protocol !== 'dsh-app:' || location.hostname !== 'app' || window.top !== window) {
    report.problem = 'existing-owner-renderer-required'; return emit()
  }
  const text = value => typeof value === 'string' && value.length <= 160 && !/[\x00-\x1f\x7f]/u.test(value) ? value : null
  const phases = new Set(['pending', 'loading', 'active', 'failed', 'unloading'])
  const applications = new Set(['applied', 'restart-required', 'failed', 'cancelled', 'overridden'])
  const reasons = new Set(['no-hmr', 'package-moved', 'host-module', 'unmanaged-plugin', 'module-comparison'])
  const errorCodes = new Set(['management-required', 'unaddressable', 'unknown-plugin', 'invalid-spec', 'already-installed', 'ambiguous-install', 'not-bundle', 'not-removable', 'stop-profile', 'bundle-in-use', 'stale-approval', 'incompatible-version', 'operation-error', 'gateway/bad-request', 'gateway/arguments-invalid', 'gateway/method-not-found', 'gateway/service-unavailable', 'gateway/cancelled'])
  async function rpc(method, args, direct = false, timeoutMs = 30000) {
    const rpcId = crypto.randomUUID()
    try {
      const response = await fetch('/api/' + method, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: direct ? args : { args } }),
      })
      if (!response.ok) { await response.body?.cancel(); return { ok: false, problem: 'http-' + response.status } }
      const chunks = []; let bytes = 0
      for await (const chunk of response.body ?? []) {
        bytes += chunk.byteLength
        if (bytes > 16 * 1024 * 1024) return { ok: false, problem: 'response-limit' }
        chunks.push(chunk)
      }
      const joined = new Uint8Array(bytes); let offset = 0
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
      const answer = JSON.parse(new TextDecoder().decode(joined))
      if (answer.type !== 'server-response' || answer.rpcId !== rpcId || typeof answer.result?.ok !== 'boolean') return { ok: false, problem: 'invalid-envelope' }
      if (!answer.result.ok) return { ok: false, problem: errorCodes.has(answer.result.error?.code) ? answer.result.error.code : 'remote-rejected' }
      return { ok: true, value: answer.result.value }
    } catch { return { ok: false, problem: 'transport-or-protocol' } }
  }
  const issue = result => ({ available: false, problem: result.problem })
  async function catalog() {
    const result = await rpc('session/modelCatalog', {})
    if (!result.ok) return issue(result)
    const value = result.value
    const provider = text(value?.default?.provider), model = text(value?.default?.model)
    const group = Array.isArray(value?.groups) ? value.groups.find(item => item?.id === provider) : undefined
    return { available: true, default: { provider, model }, models: (Array.isArray(group?.models) ? group.models : []).slice(0, 24).map(item => ({
      id: text(item?.id), name: text(item?.name), inputModalities: Array.isArray(item?.inputModalities) ? [...new Set(item.inputModalities.filter(value => value === 'text' || value === 'image'))] : null,
    })), modalitiesNote: 'The public selector may omit modalities; null means undisclosed, not text-only.' }
  }
  async function plugins() {
    const result = await rpc('pluginManager/listPlugins', {})
    const bundles = await rpc('pluginManager/listBundles', {}) // Version lives on bundles, not plugin display metadata.
    const rows = result.ok && Array.isArray(result.value) ? result.value : []
    const own = rows.filter(item => item?.moduleName === 'dsh-qiuya-tools')
    const bundle = bundles.ok && Array.isArray(bundles.value) ? bundles.value.find(item => item?.name === 'dsh-qiuya-tools') : undefined
    return { available: result.ok && bundles.ok, ...(!result.ok ? { problem: result.problem } : !bundles.ok ? { problem: bundles.problem } : {}),
      qiuya: { version: text(bundle?.version), enabled: typeof bundle?.enabled === 'boolean' ? bundle.enabled : null,
        runtimePhases: own.map(item => phases.has(item.fiberPhase) ? item.fiberPhase : null),
        versionSource: 'package-manifest; computerStatus separately proves new Host route' },
      hmrActive: rows.some(item => item?.moduleName === '@deepseek-ai/dsh-hmr' && item.fiberPhase === 'active'),
    }
  }
  async function background() {
    const result = await rpc('session/list', { _request: {} })
    if (!result.ok) return issue(result)
    const items = Array.isArray(result.value?.items) ? result.value.items : []
    return { available: true, runningSessionIds: items.filter(item => item?.running === true).map(item => text(item.sessionId)).filter(Boolean).slice(0, 64) }
  }
  async function computerStatus() {
    const result = await rpc('qiuya-tools.computer.control', { op: 'status' }, true)
    if (!result.ok) return issue(result)
    const value = result.value
    return { available: true, enabled: value?.enabled === true, switching: value?.switching === true,
      sessionCount: Array.isArray(value?.sessions) ? value.sessions.length : null,
      nativeAvailable: typeof value?.native?.available === 'boolean' ? value.native.available : null }
  }
  if (config.mode === 'read-only') {
    report.catalog = await catalog(); report.plugins = await plugins(); report.background = await background()
    return emit()
  }
  report.candidateSHA256 = config.sha256
  report.before = { plugins: await plugins(), background: await background() }
  if (!report.before.plugins.available || !report.before.background.available) {
    report.problem = 'install-preflight-unavailable'; return emit()
  }
  const guardKey = 'qiuya-owner-install-attempt:' + config.sha256
  let previous
  try { previous = sessionStorage.getItem(guardKey) } catch { report.problem = 'install-guard-unavailable'; return emit() }
  if (previous !== null) {
    // The official requestId is correlation, not a durable idempotency key.
    // Survives a renderer refresh: an unknown reply must never repeat install.
    report.install = { attempted: false, duplicateSuppressed: true, application: null, problem: 'candidate-already-attempted-in-this-renderer-session' }
  } else {
    const requestId = crypto.randomUUID()
    try { sessionStorage.setItem(guardKey, JSON.stringify({ requestId, startedAt: Date.now() })) }
    catch { report.problem = 'install-guard-unavailable'; return emit() }
    const result = await rpc('pluginManager/installBundle', { spec: config.path, options: { enabled: true, saveExact: true, requestId } }, false, 120000)
    const value = result.ok ? result.value : undefined
    report.install = { attempted: true, requestId, application: applications.has(value?.application) ? value.application : null,
      applied: value?.application === 'applied', restartRequired: value?.application === 'restart-required', restartReason: reasons.has(value?.restartReason) ? value.restartReason : null,
      changed: typeof value?.changed === 'boolean' ? value.changed : null, version: text(value?.version),
      ...(!result.ok ? { problem: result.problem } : value?.error ? { problem: errorCodes.has(value.error.code) ? value.error.code : 'install-rejected' } : {}) }
  }
  report.after = { plugins: await plugins(), computerStatus: await computerStatus(), background: await background() }
  return emit()
}

export function ownerRendererClosure(mode, candidatePath, sha256 = OWNER_CANDIDATE_SHA256) {
  if (!['read-only', 'install'].includes(mode)) throw new Error('Unsupported owner probe mode')
  return `(${ownerProbe.toString()})(${JSON.stringify({ mode, ...(mode === 'install' ? { path: candidatePath, sha256 } : {}) })})\n`
}

export async function generateOwnerRendererFiles({ output = resolve(root, 'artifacts/model-capability-resumed'), candidate = resolve(root, 'artifacts/dsh-qiuya-tools-darwin-universal.tgz') } = {}) {
  const sha256 = createHash('sha256').update(await readFile(candidate)).digest('hex')
  if (sha256 !== OWNER_CANDIDATE_SHA256) throw new Error('The candidate is not the explicitly selected 58126d4a package')
  await mkdir(output, { recursive: true })
  const files = []
  for (const [name, mode] of [['readonly-console.js', 'read-only'], ['install-console.js', 'install']]) {
    const source = ownerRendererClosure(mode, resolve(candidate), sha256)
    await writeFile(resolve(output, name), source)
    files.push({ file: name, mode, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') })
  }
  const manifest = { kind: 'existing-owner-console-closures-only', candidateSHA256: sha256, generatedAt: new Date().toISOString(), files, inferenceRequestSent: false, actualInstallationExecuted: false, credentialFilesRead: false }
  await writeFile(resolve(output, 'closures-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outputFlag = process.argv.indexOf('--output')
  const output = outputFlag < 0 ? undefined : process.argv[outputFlag + 1]
  if (outputFlag >= 0 && !output) throw new Error('--output requires a directory')
  console.log(JSON.stringify(await generateOwnerRendererFiles({ output }), null, 2))
}
