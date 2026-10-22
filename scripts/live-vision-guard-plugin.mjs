/** Temporary test plugin. Install only through the owner's official HMR gate. */
import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createComputerAgentServer, NativeCompanionDriver, RemoteComputerDriver, COMPUTER_AGENT_PATH } from '../src/features/computer-use/remote.ts'
import { VISION_TOOLS, NATURAL_VISION_TOOLS, VisionPolicy, naturalVisionPrompt, visionApprovalReadback, sameVisionTarget, projectVisionTool, visionActionUsage, visionAssistantDisplayEvidence, VISION_DIAGNOSTIC_PHASES, VISION_DIAGNOSTIC_CODES, projectVisionFailure, projectVisionNativeStatus, withVisionFailureEvidence, projectVisionTurnError, persistVisionFinalImage } from './live-vision-guard-core.mjs'
import { validateExternalConfig, validateExternalBinding, sameExternalIdentity, sameExternalExecutable, readPrivateJSON, writePrivateJSON, removePrivateJSON, externalFile, visionDigest, externalCleanupPassed } from './live-vision-external-core.mjs'
import { installVisionHostAutoRun } from './live-vision-host-autorun.mjs'

export const name = 'qiuya-live-vision-test-only'
export const inject = ['agents', 'tools', 'connection', 'webServer', 'agentDefaultModel', 'sessionController', 'llm']
const endpoint = '/api/qiuya-tools.vision-test', clientEndpoint = '/api/qiuya-tools.vision-test-client'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const bounded = (promise, ms, code) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms)
  Promise.resolve(promise).then(done, reject).finally(() => clearTimeout(timer))
})
const safeError = error => projectVisionFailure(error).code
const fail = code => { throw Object.assign(new Error(code), { code }) }
const prompts = {
  1: '这是专用视觉订单核验测试。先用 qiuya_computer_observe 看图，在图中找到绿色“确认本单”按钮并点击，再观察确认已完成。最后回答图顶部实际显示的六位订单核验码。不要猜码，不要操作别的窗口。只使用提供的四个电脑工具；最多12轮、180秒，完成立即停止。',
  2: '这是独立的视觉收货备注测试。先观察图片，把图中显示的整条收货备注逐字输入文本框，按Enter提交；再观察确认已完成。最后回答图顶部实际显示的六位订单核验码。备注和核验码都必须从图片读取，不要猜。只操作这一个专用窗口，只使用提供的四个电脑工具，最多12轮、180秒。',
  3: '这是独立的视觉订单分拣测试。先观察图片，把蓝色订单卡拖到绿色“已核验”框内，再观察确认已完成。最后回答图上订单卡实际显示的六位核验码。不要猜码，只操作这一个专用窗口，只使用提供的四个电脑工具，最多12轮、180秒。',
}
export function visionOwnerClientSource() {
  return `const VISION_DIAGNOSTIC_PHASES=${JSON.stringify(VISION_DIAGNOSTIC_PHASES)},VISION_DIAGNOSTIC_CODES=${JSON.stringify(VISION_DIAGNOSTIC_CODES)};const projectVisionFailure=${projectVisionFailure.toString()};const runVisionAcceptanceWithFetch=${runVisionAcceptanceWithFetch.toString()};export const run=${runInOwnerRenderer.toString()};`
}
/** Test-only publisher. It cannot read any session outside the exact own SID. */
export async function persistVisionAssistantDisplay(directory, session, sessionId, task) {
  const value = visionAssistantDisplayEvidence(session, sessionId)
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || ![1, 2, 3].includes(task)) fail('VISION_SESSION_NOT_OWNED')
  await mkdir(directory, { recursive: true }); const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) fail('VISION_EXTERNAL_FILE_BOUNDARY')
  const canonical = await realpath(directory); await chmod(canonical, 0o700)
  await writePrivateJSON(join(canonical, `task-${task}-assistant-display.private.json`), value.privateEvidence)
  return { ...value.summary, privateTextEvidenceStored: true }
}

export function apply(ctx, config) {
  if (process.platform !== 'darwin') fail('VISION_MAC_REQUIRED')
  if (!config || config.fixtureTemplate !== undefined && typeof config.fixtureTemplate !== 'string' || config.externalCarrierConfig !== undefined && typeof config.externalCarrierConfig !== 'string' || typeof config?.native !== 'string' || typeof config?.directory !== 'string') fail('VISION_CONFIG_REQUIRED')
  const directory = resolve(config.directory), template = resolve(config.fixtureTemplate ?? fileURLToPath(new URL('./fixture-template.app', import.meta.url))), native = resolve(config.native)
  const records = new Map(), reports = [], preparationFailures = []; let active, disposed = false, delivery, ownerFailure, externalConfig, carrierCancellation
  const originals = new Map(VISION_TOOLS.map(name => [name, ctx.tools.get(name)]))
  const naturalEntryEnabled = config.testOnlyNaturalEntry === true
  if (naturalEntryEnabled && (config.testOnlyAutoRun !== true || config.testOnlyOwnerOnce !== true || config.testOnlyProbeOnly === true)) fail('VISION_NATURAL_CONFIGURATION')
  if (naturalEntryEnabled) for (const name of NATURAL_VISION_TOOLS) originals.set(name, ctx.tools.get(name))
  if ([...originals.values()].some(value => !value)) fail('VISION_PRODUCTION_TOOLS_MISSING')
  const owner = () => ctx.connection.browserPeer?.principal?.kind === 'owner'
  const own = sessionId => { const value = records.get(sessionId); if (!value) fail('VISION_SESSION_NOT_OWNED'); return value }
  function readNaturalApproval(record) {
    record.approvalReadback = visionApprovalReadback(ctx.get?.('approval'), record.handle.agent.session)
    if (record.approvalReadback.allowedNewRequests !== true) fail('VISION_NATURAL_APPROVAL_POLICY')
    return record.approvalReadback
  }
  async function save() { await mkdir(join(directory, 'evidence'), { recursive: true }); await writeFile(join(directory, 'evidence/report.json'), JSON.stringify({ kind: 'real-existing-account-scoped-Agent-visual-business-tasks', status: ownerFailure || preparationFailures.length || reports.some(row => !row.passed || !row.cleanup?.passed) || delivery?.passed === false ? 'failed' : reports.length === 3 && delivery?.passed ? 'passed' : 'not-complete', tasks: reports, preparationFailures, ...(ownerFailure ? { ownerFailure } : {}), ...(carrierCancellation ? { carrierCancellation } : {}), delivery: delivery ?? { status: 'pending' }, modelDefaultsChanged: false }, null, 2)) }
  async function checkNative(record, targetId = record.target.id) {
    if (targetId !== record.target.id || record.fixture.exitCode !== null || record.fixture.signalCode !== null) fail('VISION_FIXTURE_RETIRED')
    let current = (await record.native.targets()).find(row => row.id === targetId)
    if (record.external && current) {
      const prefix = `${record.native.deviceId}:`
      if (!current.appId.startsWith(prefix)) fail('VISION_TARGET_CHANGED')
      current = { ...current, appId: current.appId.slice(prefix.length) }
    }
    if (!sameVisionTarget(current, record.target)) fail('VISION_TARGET_CHANGED')
    return current
  }
  async function snapshotFixture(record) {
    const requestId = ++record.snapshotSequence
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { record.pending.delete(requestId); reject(Object.assign(new Error('VISION_ORACLE_TIMEOUT'), { code: 'VISION_ORACLE_TIMEOUT' })) }, 5000)
      record.pending.set(requestId, value => { clearTimeout(timer); done(value) }); record.fixture.stdin.write(`snapshot ${requestId}\n`)
    })
  }
  async function selected(record, exec) {
    await checkNative(record)
    const value = await originals.get('qiuya_computer_status').execute({}, exec)
    if (!value?.target || value.target.id !== record.target.id || value.target.pid !== record.target.pid || value.target.appId !== record.authorizedAppId) fail('VISION_SELECTED_TARGET_CHANGED')
    return value
  }
  async function externalRead(path, ms = 20000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { return await readPrivateJSON(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await sleep(50)
    }
    fail('VISION_EXTERNAL_DEADLINE')
  }
  async function externalPrepare(record, ready, bundleId, app) {
    record.phase = 'external-wait'
    const cfg = validateExternalConfig(await readPrivateJSON(resolve(config.externalCarrierConfig))); externalConfig = cfg
    if (cfg.directory !== directory || cfg.native !== await realpath(native) || visionDigest(await readFile(cfg.native)) !== cfg.nativeSha256 ||
        visionDigest(await readFile(join(app, 'Contents/MacOS/fixture'))) !== cfg.fixtureSha256 || visionDigest(await readFile(cfg.carrier)) !== cfg.carrierSha256) fail('VISION_EXTERNAL_SOURCE_CHANGED')
    const carrier = await externalRead(join(cfg.directory, 'external', 'carrier-ready.json'))
    if (carrier.runId !== cfg.runId || carrier.rendezvousNonce !== cfg.rendezvousNonce || !carrier.carrierIdentity?.pid) fail('VISION_EXTERNAL_BINDING')
    const request = { version: 1, runId: cfg.runId, rendezvousNonce: cfg.rendezvousNonce, requestId: randomUUID(), task: record.task,
      sessionId: record.sessionId, pid: ready.pid, parentPid: process.pid, bundleId, windowId: ready.windowId,
      executablePath: await realpath(join(app, 'Contents/MacOS/fixture')), fixtureSha256: cfg.fixtureSha256, nativeSha256: cfg.nativeSha256 }
    record.external = { config: cfg, request }
    await writePrivateJSON(externalFile(cfg, record.task, 'request'), request)
    const paired = validateExternalBinding(await externalRead(externalFile(cfg, record.task, 'ready')), request, cfg)
    const url = new URL(paired.endpoint)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== COMPUTER_AGENT_PATH || url.username || url.password || url.search || url.hash ||
        !/^[a-f0-9]{64}$/u.test(paired.token) || !sameExternalIdentity(paired.carrierIdentity, carrier.carrierIdentity) ||
        paired.fixtureIdentity?.pid !== ready.pid || paired.fixtureIdentity?.parentPid !== process.pid || !await sameExternalExecutable(paired.fixtureIdentity?.executablePath, request.executablePath) ||
        paired.nativeIdentity?.parentPid !== carrier.carrierIdentity.pid || !await sameExternalExecutable(paired.nativeIdentity?.executablePath, cfg.native) ||
        paired.target?.id !== `mac-window:${ready.windowId}` || paired.target.pid !== ready.pid || paired.target.appId !== bundleId) fail('VISION_EXTERNAL_BINDING')
    record.external.fixtureIdentity = paired.fixtureIdentity; record.external.nativeIdentity = paired.nativeIdentity
    record.target = paired.target; record.pairToken = paired.token; record.pairEndpoint = paired.endpoint
    record.native = new RemoteComputerDriver({ endpoint: paired.endpoint, token: paired.token })
  }
  async function prepare(task) {
    if (disposed || active || task !== reports.length + 1 || ![1, 2, 3].includes(task)) fail('VISION_TASK_SEQUENCE')
    const sessionId = config.testOnlyAutoRun === true ? config.testOnlySessionIds?.[task - 1] : `qiuya-vision-${randomUUID()}`, bundleId = `com.qiuya.tools.vision-${randomUUID()}`
    if (typeof sessionId !== 'string' || !/^qiuya-vision-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(sessionId)) fail('VISION_SESSION_NOT_OWNED')
    const app = join(directory, 'runtime', `${sessionId}.app`), cwd = join(directory, 'runtime', sessionId)
    const record = { sessionId, task, nonce: randomBytes(3).toString('hex').toUpperCase(), pending: new Map(), snapshotSequence: 0, events: [], completedText: '', settled: false, phase: 'prepare-start', streamAttempts: 0 }
    record.testOnlyNaturalEntry = naturalEntryEnabled && task === 1
    record.toolNames = record.testOnlyNaturalEntry ? NATURAL_VISION_TOOLS : VISION_TOOLS
    if (record.testOnlyNaturalEntry) record.ownerOnceConfirmed = new Promise(resolve => { record.confirmOwnerOnce = resolve })
    active = record; records.set(sessionId, record)
    try {
      await mkdir(join(directory, 'evidence'), { recursive: true })
      record.phase = 'fixture-directory'; await mkdir(cwd, { recursive: true })
      record.phase = 'fixture-copy'; await cp(template, app, { recursive: true, errorOnExist: true, force: false })
      record.phase = 'fixture-metadata'
      await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
      record.phase = 'fixture-launch'
      record.fixture = spawn(join(app, 'Contents/MacOS/fixture'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
      record.fixture.stderr.resume(); record.fixture.stdin.on('error', () => {})
      record.fixture.once('error', () => { record.fatal = 'VISION_FIXTURE_STARTUP' })
      let buffer = '', ready
      record.fixture.stdout.on('data', chunk => {
        buffer += chunk.toString(); if (buffer.length > 65536) { record.fatal = 'VISION_FIXTURE_PROTOCOL'; return }
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          try { const value = JSON.parse(buffer.slice(0, end)); if (value.event === 'ready') ready = value; else { const pending = record.pending.get(value.requestId); if (pending) { record.pending.delete(value.requestId); pending(value) } } } catch { record.fatal = 'VISION_FIXTURE_PROTOCOL' }
          buffer = buffer.slice(end + 1)
        }
      })
      record.fixture.stdin.write(JSON.stringify({ task, nonce: record.nonce, note: `青山路18号，请轻放，核验码${record.nonce}`, seed: randomBytes(2).readUInt16BE() }) + '\n')
      record.phase = 'fixture-ready'
      for (let i = 0; i < 150 && !ready; i++) { if (record.fixture.exitCode !== null || record.fatal) fail('VISION_FIXTURE_STARTUP'); await sleep(100) }
      if (!ready || ready.pid !== record.fixture.pid || ready.bundleId !== bundleId) fail('VISION_FIXTURE_IDENTITY')
      if (config.externalCarrierConfig) await externalPrepare(record, ready, bundleId, app)
      else record.native = new NativeCompanionDriver({ executable: native })
      record.phase = 'native-status'
      record.nativeStatus = projectVisionNativeStatus(await record.native.status())
      await writeFile(join(directory, `evidence/native-status-task-${task}.json`), JSON.stringify(record.nativeStatus, null, 2))
      if (record.nativeStatus.available !== true) fail('VISION_NATIVE_UNAVAILABLE')
      if (record.nativeStatus.permissions.screenRecording !== true) fail('VISION_NATIVE_SCREEN_PERMISSION')
      if (record.nativeStatus.permissions.accessibility !== true) fail('VISION_NATIVE_ACCESSIBILITY_PERMISSION')
      record.phase = 'fixture-target'
      if (!record.external) record.target = (await record.native.targets()).find(row => row.id === `mac-window:${ready.windowId}` && row.pid === ready.pid && row.appId === bundleId)
      if (!record.target) fail('VISION_FIXTURE_TARGET_MISSING')
      const fixed = {
        async status(signal) { await checkNative(record); return record.native.status(signal) },
        async targets() { return [await checkNative(record)] },
        async observe(targetId, signal) { await checkNative(record, targetId); return record.native.observe(targetId, signal) },
        async preview(targetId, signal) { await checkNative(record, targetId); return record.native.preview(targetId, signal) },
        async lease(epoch, signal) { await checkNative(record); return record.native.lease(epoch, signal) },
        release: (epoch, signal) => record.native.release(epoch, signal),
        async act(epoch, targetId, action, signal) { await checkNative(record, targetId); return record.native.act(epoch, targetId, action, signal) },
        async openPreview() { fail('VISION_PREVIEW_NOT_EXPOSED') }, async closePreview() {}, subscribe: listener => record.native.subscribe(listener),
      }
      if (!record.external) {
        record.pairToken = randomBytes(32).toString('hex')
        record.phase = 'pair-server'
        record.server = await createComputerAgentServer(fixed, { token: record.pairToken, host: '127.0.0.1', port: 0 })
        record.pairEndpoint = record.server.endpoint
      }
      record.phase = 'pair-identity'
      const identityDriver = new RemoteComputerDriver({ endpoint: record.pairEndpoint, token: record.pairToken })
      record.authorizedAppId = `${identityDriver.deviceId}:${bundleId}`; await identityDriver.dispose()
      if (record.testOnlyNaturalEntry) {
        const applications = await record.native.applications()
        if (applications.length !== 1 || applications[0].appId !== record.authorizedAppId) fail('VISION_NATURAL_APPLICATION')
        record.applicationName = applications[0].name.split(/[\\/]/u).at(-1).replace(/\.exe$/iu, '')
        record.naturalPrompt = naturalVisionPrompt(record.applicationName)
      }
      record.phase = 'model-selection'; const selection = ctx.agentDefaultModel.currentSelection()
      record.policy = new VisionPolicy({ sessionId, task, target: record.target, selection, testOnlyNaturalEntry: record.testOnlyNaturalEntry })
      record.phase = 'agent-create'
      record.handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { ...selection, maxTokens: 4096 }, setup(agentCtx, agent) {
        record.phase = 'agent-setup'
        agentCtx.tools.presentAs('native'); agentCtx.tools.restrict({ allow: record.toolNames })
        agentCtx.tools.guard(exec => record.policy.toolGuard(exec))
        for (const name of record.toolNames) {
          const definition = originals.get(name)
          agentCtx.tools.register({ ...definition, async execute(args, exec) {
            if (exec.agent?.id !== sessionId || record.testOnlyNaturalEntry && exec.agent !== record.handle?.agent) fail('VISION_CALLER_CHANGED')
            return withVisionFailureEvidence(async () => {
            record.policy.assertActive()
            if (record.testOnlyNaturalEntry) {
              if (ctx.agents.get(sessionId) !== exec.agent || !ctx.agents.roots().includes(exec.agent)) fail('VISION_CALLER_CHANGED')
              if (name === 'qiuya_computer_request_control') record.policy.requestEntry(args)
              if (['qiuya_computer_observe', 'qiuya_computer_act', 'qiuya_computer_pause'].includes(name)) await selected(record, exec)
            } else await selected(record, exec)
            const result = await definition.execute(args, exec)
            if (record.testOnlyNaturalEntry && name === 'qiuya_computer_request_control') record.controlStarted = true
            await checkNative(record)
            if (record.testOnlyNaturalEntry && name === 'qiuya_computer_discover') record.policy.recordDiscovery(result)
            if (record.testOnlyNaturalEntry && name === 'qiuya_computer_request_control') {
              await bounded(record.ownerOnceConfirmed, Math.min(10000, 180000 - (Date.now() - record.policy.startedAt)), 'VISION_NATURAL_APPROVAL')
              record.policy.recordEntryReady(result, record.authorizedAppId); await selected(record, exec)
            }
            if (name === 'qiuya_computer_observe') {
              if (result.targetId !== record.target.id) fail('VISION_OBSERVATION_CHANGED')
              // This check runs before the first tool result reaches the model.
              // Later task-2 AX may legitimately contain text the model typed.
              record.policy.recordObservation(result, record.nonce)
            }
            record.policy.tools.push(projectVisionTool(name, args, result)); return result
            }, () => record.native.status(AbortSignal.timeout(1000)), failure => {
              if (record.policy.tools.length < 128) record.policy.tools.push({ name, isError: true, failure })
            })
          } })
        }
        agentCtx.on('agent/pre-step', async (payload, next) => {
          if (payload.agent.id !== sessionId) return next()
          try { record.policy.enterStep(); return await next() } catch (error) { record.fatal = safeError(error); return { kind: 'reject' } }
        })
        agentCtx.on('session/event', (session, event) => {
          if (session.id !== sessionId) return
          if (event.type === 'assistant/message') {
            const content = event.data.message.content ?? []
            record.completedText += content.filter(block => block.type === 'text').map(block => block.text).join('')
            record.completedText = record.completedText.slice(-20000)
          }
          if (event.type === 'turn/end' && event.data.reason?.kind === 'error') {
            record.terminalError = projectVisionTurnError(event.data.reason.error)
            record.fatal ??= 'VISION_TURN_ERROR'; clearTimeout(record.timer)
          }
          if (['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type)) record.events.push({ type: event.type, seq: event.seq, time: event.time, turn: event.data.turn, step: event.data.step, ...(event.type === 'turn/end' ? { reason: event.data.reason?.kind, ...(record.terminalError ? { terminalError: record.terminalError } : {}) } : {}) })
        })
        return { commit() { record.phase = 'tool-publication'; const tools = agentCtx.tools.schemas(agent); if (tools.length !== record.toolNames.length || tools.some(tool => !record.toolNames.includes(tool.name))) fail('VISION_TOOL_PUBLICATION_BOUNDARY') } }
      } })
      record.phase = 'prepare-complete'
      if (record.testOnlyNaturalEntry && (ctx.agents.get(sessionId) !== record.handle.agent || !ctx.agents.roots().includes(record.handle.agent))) fail('VISION_CALLER_CHANGED')
      if (record.testOnlyNaturalEntry) readNaturalApproval(record)
      return { sessionId, task, targetId: record.target.id, authorizedAppId: record.authorizedAppId, testOnlyNaturalEntry: record.testOnlyNaturalEntry, endpoint: record.pairEndpoint, token: record.pairToken, prompt: record.naturalPrompt ?? prompts[task] + '\n' + visionActionUsage(task), model: record.policy.selection }
    } catch (error) {
      const diagnostic = projectVisionFailure(error, record.phase); record.fatal = diagnostic.code
      const cleanupResult = await cleanup(record).catch(() => ({ passed: false, errors: ['VISION_CLEANUP_FAILED'] }))
      const failure = { status: 'failed', task, diagnostic, nativeStatus: record.nativeStatus ?? { status: 'not-read' }, ownedStreamAttemptsObserved: record.streamAttempts, networkDispatchCount: 'not-proven', cleanup: cleanupResult }
      preparationFailures.push(failure); if (active === record) active = undefined
      try { await writeFile(join(directory, 'evidence/preparation-failure.json'), JSON.stringify(failure, null, 2)); await save() }
      catch { throw Object.assign(new Error('VISION_DIAGNOSTIC_WRITE_FAILED'), { code: 'VISION_DIAGNOSTIC_WRITE_FAILED', diagnostic }) }
      throw Object.assign(new Error(diagnostic.code), { code: diagnostic.code, diagnostic })
    }
  }
  async function arm(record) {
    if (record.testOnlyNaturalEntry) {
      readNaturalApproval(record)
      await checkNative(record)
      const state = await originals.get('qiuya_computer_status').execute({}, { agent: record.handle.agent, callId: 'test-owner-identity', signal: AbortSignal.timeout(10000) })
      if (state?.state !== 'idle' || ctx.agents.get(record.sessionId) !== record.handle.agent || !ctx.agents.roots().includes(record.handle.agent)) fail('VISION_NATURAL_NOT_IDLE')
    } else await selected(record, { agent: record.handle.agent, callId: 'test-owner-identity', signal: AbortSignal.timeout(10000) })
    record.policy.arm()
    record.timer = setTimeout(() => {
      record.fatal ??= 'VISION_DEADLINE'; record.handle.agent.cancel({ kind: 'hook', reason: 'bounded-visual-test-deadline' })
      // Retain bearer validity until the production RemoteDriver receives its
      // release ACK. Premature pair rotation would deliberately fence that
      // client's uncertain native epoch and prevent restoring local mode.
      record.deadlineRelease = record.testOnlyNaturalEntry && !record.controlStarted ? Promise.resolve() : originals.get('qiuya_computer_pause').execute({}, { agent: record.handle.agent, callId: 'test-deadline-release', signal: AbortSignal.timeout(15000) })
      void record.deadlineRelease.catch(() => { record.fatal = 'VISION_CLEANUP_FAILED' })
    }, 180000); record.timer.unref()
    return { armed: true, maxRequests: 12, deadlineMs: 180000 }
  }
  async function status(record) {
    if (!record.handle || !record.policy) fail('VISION_NOT_PREPARED')
    const oracle = await snapshotFixture(record)
    return { sessionId: record.sessionId, state: record.handle.agent.status, steps: record.policy.steps, requests: record.policy.requests.length,
      ...(record.testOnlyNaturalEntry ? { testOnlyNaturalEntry: true, approvalReadback: record.approvalReadback, entryRequested: record.policy.entry.requested, entryApproved: record.policy.entry.approved, preauthorization: record.preauthorization ?? null } : {}),
      businessPassed: oracle.passed === true, visualNonceRead: record.completedText.includes(record.nonce), fatal: record.fatal ?? null, terminalError: record.terminalError ?? null }
  }
  async function cleanup(record) {
    if (!record.cleanupPromise) record.cleanupPromise = cleanupRecord(record)
    return record.cleanupPromise
  }
  async function cleanupRecord(record) {
    clearTimeout(record.timer)
    const errors = []; let fixtureForced = false
    if (record.handle) {
      record.handle.agent.cancel({ kind: 'hook', reason: 'owned-visual-test-cleanup' })
      let idleConfirmed = false
      try { await bounded(record.handle.agent.whenIdle(), 15000, 'VISION_AGENT_DRAIN_TIMEOUT'); idleConfirmed = true } catch (error) { errors.push(safeError(error)) }
      try { record.assistantDisplay = { ...await persistVisionAssistantDisplay(join(directory, 'evidence'), record.handle.agent.session, record.sessionId, record.task), idleConfirmed } }
      catch { errors.push('VISION_DIAGNOSTIC_WRITE_FAILED') }
      if (record.policy?.startedAt && (!record.testOnlyNaturalEntry || record.controlStarted)) try {
        await record.deadlineRelease
        await originals.get('qiuya_computer_pause').execute({}, { agent: record.handle.agent, callId: 'test-final-release', signal: AbortSignal.timeout(15000) })
      } catch { errors.push('VISION_REMOTE_RELEASE_UNCONFIRMED') }
    }
    // Pair revoke releases its native lease before its ACK. No new bearer or
    // auth URL is saved, emitted to Console, or admitted to the model surface.
    try { await record.server?.revoke() } catch { errors.push('VISION_PAIR_REVOKE_FAILED') }
    try { await record.server?.close() } catch { errors.push('VISION_PAIR_CLOSE_FAILED') }
    record.pairToken = undefined
    try { await record.native?.dispose() } catch { errors.push('VISION_NATIVE_CLEANUP_FAILED') }
    if (record.external) try {
      const { config: cfg, request } = record.external
      await writePrivateJSON(externalFile(cfg, record.task, 'stop'), { version: 1, runId: cfg.runId, rendezvousNonce: cfg.rendezvousNonce, requestId: request.requestId, sessionId: request.sessionId, task: record.task })
      const receipt = validateExternalBinding(await externalRead(externalFile(cfg, record.task, 'cleanup'), 30000), request, cfg)
      if (!externalCleanupPassed(receipt.cleanup)) errors.push('VISION_EXTERNAL_CLEANUP_FAILED')
      await removePrivateJSON(externalFile(cfg, record.task, 'cleanup'))
    } catch { errors.push('VISION_EXTERNAL_CLEANUP_FAILED') }
    if (record.fixture && record.fixture.exitCode === null && record.fixture.signalCode === null) {
      record.fixture.stdin.end('quit\n')
      for (let i = 0; i < 50 && record.fixture.exitCode === null && record.fixture.signalCode === null; i++) await sleep(100)
      if (record.fixture.exitCode === null && record.fixture.signalCode === null) {
        errors.push('VISION_FIXTURE_EXIT_UNCONFIRMED'); fixtureForced = true; record.fixture.kill('SIGTERM')
        for (let i = 0; i < 20 && record.fixture.exitCode === null && record.fixture.signalCode === null; i++) await sleep(100)
      }
    }
    if (record.fixture && record.fixture.exitCode !== 0) errors.push('VISION_FIXTURE_NATURAL_EXIT_FAILED')
    try { await record.handle?.dispose() } catch { errors.push('VISION_AGENT_DISPOSE_FAILED') }
    record.policy?.finish(); return { passed: errors.length === 0, errors, fixtureNaturalExit: !fixtureForced && record.fixture?.exitCode === 0, fixtureForced, onlyOwnedSessionAffected: true }
  }
  const unStream = ctx.on('llm/stream', async function* (options, next) {
    const record = records.get(options.sessionId)
    if (!record) { yield* next(); return }
    record.streamAttempts++
    if (!record.policy) fail('VISION_NOT_PREPARED')
    try { record.policy.admitRequest(options); yield* next() }
    catch (error) { record.fatal = safeError(error); throw error }
  })
  const unregister = [ctx.connection.fetch.register({ path: endpoint, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    if (!owner()) return new Response('Forbidden', { status: 403 })
    try {
      const text = await request.text(); if (text.length > 64000) fail('VISION_BODY_BOUND')
      const input = JSON.parse(text); let value
      if (input.op === 'catalog') value = { temporaryTestGuard: true, defaults: ctx.agentDefaultModel.currentSelection(), tasks: reports.length, active: !!active }
      else if (input.op === 'prepare') value = await prepare(input.task)
      else if (input.op === 'failure') {
        ownerFailure = projectVisionFailure({ code: input.code }, input.phase)
        await mkdir(join(directory, 'evidence'), { recursive: true })
        await writeFile(join(directory, 'evidence/owner-failure.json'), JSON.stringify({ status: 'failed', diagnostic: ownerFailure, networkDispatchCount: 'not-proven' }, null, 2))
        await save(); value = { recorded: true }
      }
      else if (input.op === 'cancel-run') {
        if (active || records.size !== 0 || !['owner-settings-read', 'owner-enable', 'owner-status'].includes(input.phase)) fail('VISION_CANCEL_NOT_IDLE')
        carrierCancellation = { requested: false, supported: false }
        await save(); value = carrierCancellation
      }
      else if (input.op === 'delivery') {
        if (typeof input.restore?.localMode !== 'boolean' || typeof input.restore?.featureFlags !== 'boolean') fail('VISION_DELIVERY_STATE')
        let carrierPassed = !externalConfig
        if (externalConfig) {
          const result = await externalRead(join(directory, 'evidence/external-carrier-report.json'), 30000)
          carrierPassed = result.runId === externalConfig.runId && result.nativeSha256 === externalConfig.nativeSha256 && result.status === 'completed' && result.oracleNaturalExit === true && result.cleanupErrors?.length === 0 && result.records?.length === 3 && result.records.every(row => externalCleanupPassed(row.cleanup) && [...records.values()].some(record => record.external?.request.requestId === row.requestId && record.sessionId === row.sessionId && record.task === row.task))
        }
        delivery = { passed: !active && input.restore.localMode && input.restore.featureFlags && carrierPassed, noOwnedActiveTask: !active, localModeRestored: input.restore.localMode, originalFeatureFlagsRestored: input.restore.featureFlags,
          externalCarrier: externalConfig ? { backendNaturalCleanupPassed: carrierPassed, scope: 'Standard paired remote mode; Harness local permissions are not established; carrier Node exit needs its launching runner receipt.' } : { enabled: false } }
        await save(); value = delivery
      }
      else {
        const record = own(input.sessionId)
        if (input.op === 'natural-once') {
          if (!record.testOnlyNaturalEntry || config.testOnlyOwnerOnce !== true || input.proof?.sessionId !== record.sessionId || input.proof?.appId !== record.authorizedAppId) fail('VISION_NATURAL_APPROVAL')
          if (input.proof.state === 'pending') record.policy.recordOwnerOnce(input.proof)
          else { record.policy.confirmOwnerOnce(input.proof); record.confirmOwnerOnce() }
          value = { recorded: true }
        }
        else if (input.op === 'arm') value = await arm(record)
        else if (input.op === 'status') value = await status(record)
        else if (input.op === 'finish') {
          if (record.settled) fail('VISION_TASK_ALREADY_SETTLED')
          record.settled = true
          const oracle = await snapshotFixture(record).catch(() => ({ passed: false }))
          const result = { ...record.policy.summary({ businessPassed: oracle.passed === true, nonceRead: record.completedText.includes(record.nonce), syntheticNonce: record.nonce }),
            ...(record.testOnlyNaturalEntry ? { approvalReadback: record.approvalReadback } : {}),
            oracle, events: record.events, target: { id: record.target.id, pid: record.target.pid, appId: record.target.appId }, fatal: record.fatal ?? null, terminalError: record.terminalError ?? null }
          Object.assign(result, await persistVisionFinalImage({ testOnlyNaturalEntry: record.testOnlyNaturalEntry, approved: record.policy?.entry?.approved }, async () => { await checkNative(record); return record.native.preview(record.target.id) }, image => writeFile(join(directory, `evidence/task-${record.task}-final.jpg`), Buffer.from(image.imageBase64, 'base64'))))
          result.cleanup = await cleanup(record); result.assistantDisplay = record.assistantDisplay ?? { status: 'not-collected' }; if (!result.cleanup.passed || result.fatal) result.passed = false
          reports.push(result); if (active === record) active = undefined; await save(); value = result
        } else if (input.op === 'cancel') { record.handle?.agent.cancel({ kind: 'user' }); value = { accepted: true } }
        else fail('VISION_OPERATION_NOT_ALLOWED')
      }
      return Response.json({ ok: true, value }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) { return Response.json({ ok: false, error: safeError(error), diagnostic: projectVisionFailure(error, error?.diagnostic?.phase) }, { headers: { 'Cache-Control': 'no-store' } }) }
  } }), ctx.connection.fetch.register({ path: clientEndpoint, methods: ['GET'], requestBody: 'buffered', async fetch() {
    return owner() ? new Response(visionOwnerClientSource(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }) : new Response('Forbidden', { status: 403 })
  } })]
  const hostAutoRun = installVisionHostAutoRun(ctx, config, { run: runVisionAcceptanceWithFetch, moduleUrl: import.meta.url })
  ctx.effect(() => async () => {
    disposed = true
    await hostAutoRun?.stop()
    const drained = await Promise.allSettled([...records.values()].map(record => cleanup(record)))
    unStream(); const removed = await Promise.allSettled(unregister.map(stop => stop()))
    await hostAutoRun?.recordDeactivation({ ownedCleanupPassed: drained.every(row => row.status === 'fulfilled' && row.value?.passed === true), routesRemoved: removed.every(row => row.status === 'fulfilled') })
  })
}

/** Existing authenticated desktop renderer only; secrets never leave memory. */
async function runInOwnerRenderer() {
  return runVisionAcceptanceWithFetch((...args) => fetch(...args))
}
/** One unchanged task/restore loop for both the owner renderer and trusted Host. */
export async function runVisionAcceptanceWithFetch(transportFetch, emit = value => console.log(JSON.stringify(value)), { probeOnly = false, testOnlyNaturalEntry = false, testOnlyOwnerOnce = false } = {}) {
  if (testOnlyNaturalEntry !== testOnlyOwnerOnce || testOnlyNaturalEntry && probeOnly) throw Object.assign(Error('VISION_NATURAL_CONFIGURATION'), { code: 'VISION_NATURAL_CONFIGURATION' })
  const rpc = async (method, args = {}, raw = false) => {
    const rpcId = crypto.randomUUID(), response = await transportFetch('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: raw ? args : { args } }), visionPhase: phase })
    const value = await response.json(); if (!response.ok || value.rpcId !== rpcId || !value.result?.ok) throw Object.assign(Error('VISION_PUBLIC_RPC_FAILED'), { code: value.result?.error?.code ? projectVisionFailure({ code: value.result.error.code }).code : 'VISION_PUBLIC_RPC_FAILED' })
    return value.result.value
  }
  const test = async input => { const response = await transportFetch('/api/qiuya-tools.vision-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const result = await response.json(); if (!result.ok) { const diagnostic = projectVisionFailure({ code: result.error }, result.diagnostic?.phase); throw Object.assign(Error(diagnostic.code), { code: diagnostic.code, diagnostic }) }; return result.value }
  let connectionDispatches = 0
  const computer = input => { if (input.op === 'connect') connectionDispatches++; return rpc('qiuya-tools.computer.control', input, true) }
  const connectionView = state => ({ nativeMode: ['local', 'remote', 'browser'].includes(state.native?.mode) ? state.native.mode : null, nativePresent: state.native !== null && state.native !== undefined, sessionsKnown: Array.isArray(state.sessions), hasActiveSession: !Array.isArray(state.sessions) || state.sessions.some(session => !['stopped', 'faulted', 'disconnected'].includes(session.state)), switching: state.switching === true })
  const keys = ['enabled', 'computerUseEnabled'], summary = [], ownedSessions = []; let original, setup, mode, failure, diagnostic, initialConnection, carrierCancellation, enableMutation, enableProof = 'not-requested', phase = 'owner-settings-read'
  const restoration = { localMode: false, featureFlags: false }
  const restorationProof = { connection: 'unconfirmed', featureFlags: 'unconfirmed' }
  let originalAllowedApps
  const checkAllowedApps = state => {
    if (!testOnlyNaturalEntry) return
    if (!Array.isArray(state?.allowedApps) || state.allowedApps.some(app => typeof app !== 'string')) throw Object.assign(Error('VISION_NATURAL_ALLOWLIST'), { code: 'VISION_NATURAL_ALLOWLIST' })
    const current = JSON.stringify([...state.allowedApps].sort())
    if (originalAllowedApps === undefined) originalAllowedApps = current
    else if (originalAllowedApps !== current) throw Object.assign(Error('VISION_NATURAL_ALLOWLIST'), { code: 'VISION_NATURAL_ALLOWLIST' })
  }
  const flagSnapshot = row => keys.map(key => ({ key, own: Object.hasOwn(row.user ?? {}, key), value: row.user?.[key], effective: row.value?.[key] }))
  const matchesSnapshot = (row, snapshot) => snapshot?.every(item => Object.hasOwn(row.user ?? {}, item.key) === item.own && (!item.own || JSON.stringify(row.user[item.key]) === JSON.stringify(item.value)) && row.value?.[item.key] === item.effective) === true
  const matchesOriginal = row => matchesSnapshot(row, original)
  const ownNamespace = described => { const rows = Array.isArray(described?.namespaces) ? described.namespaces.filter(row => row?.ns === 'qiuya-tools') : []; if (rows.length !== 1 || rows[0].writable === false || !Number.isSafeInteger(rows[0].revision)) throw Object.assign(Error('VISION_SETTINGS_SNAPSHOT_INVALID'), { code: 'VISION_SETTINGS_SNAPSHOT_INVALID' }); return rows[0] }
  const setEnabled = async () => {
    const described = await rpc('settings/describe'), row = ownNamespace(described)
    if (keys.some(key => typeof row.value?.[key] !== 'boolean')) throw Object.assign(Error('VISION_SETTINGS_SNAPSHOT_INVALID'), { code: 'VISION_SETTINGS_SNAPSHOT_INVALID' })
    if (!matchesOriginal(row)) throw Object.assign(Error('settings/conflict'), { code: 'settings/conflict' })
    const pending = keys.filter(key => row.value[key] === false)
    if (pending.length === 0) { enableProof = 'already-enabled-readback'; return }
    if (described.writable !== true) throw Object.assign(Error('VISION_WRITABLE_FEATURE_SETTING_REQUIRED'), { code: 'VISION_WRITABLE_FEATURE_SETTING_REQUIRED' })
    enableProof = 'unconfirmed'
    enableMutation = { keys: pending, confirmed: false }
    const written = await rpc('settings/mutate', { ns: 'qiuya-tools', ops: pending.map(key => ({ op: 'set', path: [key], value: true })), expectedRevision: row.revision })
    // The installed settings provider increments a changed raw generation once
    // and the public controller returns that namespace view. A different
    // generation can include another owner's write and cannot be adopted.
    if (written?.ns !== 'qiuya-tools' || !Number.isSafeInteger(written.revision) || written.revision !== row.revision + 1 || !keys.every(key => written.value?.[key] === true) || !pending.every(key => Object.hasOwn(written.user ?? {}, key) && written.user[key] === true)) throw Object.assign(Error('VISION_FEATURE_ENABLE_UNCONFIRMED'), { code: 'VISION_FEATURE_ENABLE_UNCONFIRMED' })
    const confirmed = ownNamespace(await rpc('settings/describe'))
    if (confirmed.revision !== written.revision || !matchesSnapshot(confirmed, flagSnapshot(written))) throw Object.assign(Error('VISION_FEATURE_ENABLE_UNCONFIRMED'), { code: 'VISION_FEATURE_ENABLE_UNCONFIRMED' })
    enableMutation = { keys: pending, confirmed: true, revision: confirmed.revision, snapshot: flagSnapshot(confirmed) }
    enableProof = 'cas-confirmed-readback'
  }
  try {
    const initialSettings = await rpc('settings/describe'), initial = ownNamespace(initialSettings)
    if (!initial || !initialSettings.writable) throw Object.assign(Error('VISION_WRITABLE_FEATURE_SETTING_REQUIRED'), { code: 'VISION_WRITABLE_FEATURE_SETTING_REQUIRED' })
    if (!Number.isSafeInteger(initial.revision) || keys.some(key => typeof initial.value?.[key] !== 'boolean' || Object.hasOwn(initial.user ?? {}, key) && typeof initial.user[key] !== 'boolean')) throw Object.assign(Error('VISION_SETTINGS_SNAPSHOT_INVALID'), { code: 'VISION_SETTINGS_SNAPSHOT_INVALID' })
    original = flagSnapshot(initial)
    phase = 'owner-status'; const initialComputerState = await computer({ op: 'status' }); checkAllowedApps(initialComputerState); initialConnection = connectionView(initialComputerState)
    if (!initialConnection.sessionsKnown || initialConnection.hasActiveSession || initialConnection.switching || initialConnection.nativeMode !== null && initialConnection.nativeMode !== 'local') throw Object.assign(Error('VISION_REQUIRES_IDLE_LOCAL_CONNECTION'), { code: 'VISION_REQUIRES_IDLE_LOCAL_CONNECTION' })
    if (!probeOnly) {
    phase = 'owner-enable'; await setEnabled()
    phase = 'owner-status'; let state = await computer({ op: 'status' }); mode = state.native?.mode
    if (mode !== 'local' || state.sessions.some(session => !['stopped', 'faulted', 'disconnected'].includes(session.state))) throw Object.assign(Error('VISION_REQUIRES_IDLE_LOCAL_CONNECTION'), { code: 'VISION_REQUIRES_IDLE_LOCAL_CONNECTION' })
    for (let task = 1; task <= 3; task++) {
      phase = 'owner-prepare'; setup = await test({ op: 'prepare', task })
      ownedSessions.push(setup.sessionId)
      const naturalTask = testOnlyNaturalEntry && task === 1
      if (naturalTask !== (setup.testOnlyNaturalEntry === true)) throw Object.assign(Error('VISION_NATURAL_CONFIGURATION'), { code: 'VISION_NATURAL_CONFIGURATION' })
      phase = 'owner-connect'; await computer({ op: 'connect', sessionId: setup.sessionId, mode: 'remote', endpoint: setup.endpoint, token: setup.token }); delete setup.token
      if (naturalTask) {
        const idle = await computer({ op: 'status', sessionId: setup.sessionId }); checkAllowedApps(idle)
        if (idle.allowedApps.includes(setup.authorizedAppId) || idle.sessions.some(row => row.sessionId === setup.sessionId && !['stopped', 'faulted', 'disconnected'].includes(row.state))) throw Object.assign(Error('VISION_NATURAL_NOT_IDLE'), { code: 'VISION_NATURAL_NOT_IDLE' })
      } else { phase = 'owner-start'; await computer({ op: 'start', sessionId: setup.sessionId, targetId: setup.targetId }) }
      phase = 'owner-arm'; await test({ op: 'arm', sessionId: setup.sessionId })
      phase = 'owner-prompt'
      await rpc('session/prompt', { request: { requestId: crypto.randomUUID(), sessionId: setup.sessionId, mode: 'queue', content: [{ type: 'text', text: setup.prompt }] } })
      phase = 'owner-wait'; let ended = false, ownerOnceAttempted = false
      for (let i = 0; i < 180; i++) {
        await new Promise(done => setTimeout(done, 1000))
        state = await test({ op: 'status', sessionId: setup.sessionId })
        if (naturalTask && state.entryRequested && !ownerOnceAttempted) {
          const pending = await computer({ op: 'pending', sessionId: setup.sessionId }), card = pending.pendingRequests?.[0]
          if (card) {
            ownerOnceAttempted = true
            if (pending.pendingRequests.length !== 1 || card.sessionId !== setup.sessionId || card.appId !== setup.authorizedAppId || card.requestVersion !== 1 || card.state !== 'pending' || state.preauthorization?.passed !== true) throw Object.assign(Error('VISION_NATURAL_APPROVAL'), { code: 'VISION_NATURAL_APPROVAL' })
            checkAllowedApps(await computer({ op: 'status', sessionId: setup.sessionId }))
            const proof = { sessionId: setup.sessionId, appId: setup.authorizedAppId, requestId: card.requestId, requestVersion: 1, decision: 'once', state: 'pending', allowedAppsUnchanged: true, preauthorization: state.preauthorization }
            await test({ op: 'natural-once', sessionId: setup.sessionId, proof })
            const decision = await computer({ op: 'decide', sessionId: setup.sessionId, requestId: card.requestId, requestVersion: 1, decision: 'once' })
            checkAllowedApps(await computer({ op: 'status', sessionId: setup.sessionId }))
            if (decision.requestId !== card.requestId || decision.state !== 'approved' || decision.decision !== 'once') throw Object.assign(Error('VISION_NATURAL_APPROVAL'), { code: 'VISION_NATURAL_APPROVAL' })
            await test({ op: 'natural-once', sessionId: setup.sessionId, proof: { ...proof, state: 'approved' } })
          }
        }
        if (state.fatal || (state.state === 'idle' && state.requests > 0)) { ended = true; break }
      }
      phase = 'owner-finish'; await rpc('session/cancel', { request: { sessionId: setup.sessionId } })
      await computer({ op: 'stop', sessionId: setup.sessionId })
      const result = await test({ op: 'finish', sessionId: setup.sessionId })
      summary.push({ task, passed: result.passed, steps: result.steps, requestAttempts: result.requestAttempts, retainedImageOccurrences: result.retainedImageOccurrences, businessPassed: result.businessPassed, visualNonceRead: result.visualNonceRead, ...(result.naturalEntry ? { naturalEntry: result.naturalEntry } : {}) })
      if (naturalTask) checkAllowedApps(await computer({ op: 'status', sessionId: setup.sessionId }))
      const finishedSession = setup.sessionId; setup = undefined; phase = 'owner-reset-local'; await computer({ op: 'connect', sessionId: finishedSession, mode: 'local' })
      // A cleanly retired mismatch or exhausted per-case budget remains failed
      // without concealing the next independent fixture. Every new case keeps
      // its own unchanged 12-request/180s guard. Never retry this case or input.
      const boundedCaseEnd = ['VISION_REQUEST_LIMIT', 'VISION_STEP_LIMIT', 'VISION_DEADLINE'].includes(result.fatal)
      if (!ended || (result.fatal && !boundedCaseEnd) || !result.cleanup?.passed || result.denials?.length) break
    }
    }
  } catch (error) {
    diagnostic = projectVisionFailure(error, error?.diagnostic?.phase !== 'unknown' && error?.diagnostic?.phase || phase); failure = diagnostic.code
    await test({ op: 'failure', phase: diagnostic.phase, code: diagnostic.code }).catch(() => {})
  }
  finally {
    if (setup?.sessionId) {
      await rpc('session/cancel', { request: { sessionId: setup.sessionId } }).catch(() => {})
      await computer({ op: 'stop', sessionId: setup.sessionId }).catch(() => {})
      await test({ op: 'finish', sessionId: setup.sessionId }).catch(() => {})
      delete setup.token
    }
    try {
      phase = 'owner-restore-connection'
      if (connectionDispatches === 0 && initialConnection) {
        const current = connectionView(await computer({ op: 'status' }))
        restoration.localMode = initialConnection.sessionsKnown && !initialConnection.hasActiveSession && JSON.stringify(current) === JSON.stringify(initialConnection)
        if (restoration.localMode) restorationProof.connection = 'unchanged-no-connect-readback'
        // Enabling the feature may expose an already-local driver that was null
        // while disabled. No connect was dispatched and no session was created.
        if (!probeOnly && mode === 'local' && ownedSessions.length === 0 && current.nativeMode === 'local' && !current.hasActiveSession) { restoration.localMode = true; restorationProof.connection = 'unchanged-no-connect-readback' }
      } else if (mode === 'local') {
        restoration.localMode = true
        for (const sessionId of ownedSessions) {
          await computer({ op: 'connect', sessionId, mode: 'local' })
          const current = await computer({ op: 'status', sessionId })
          restoration.localMode &&= current.native?.mode === 'local' && current.sessions.filter(session => session.sessionId === sessionId).every(session => ['stopped', 'faulted', 'disconnected'].includes(session.state))
        }
        if (restoration.localMode) restorationProof.connection = 'restored-local'
      }
    } catch { failure ??= 'VISION_CONNECTION_RESTORE_FAILED' }
    try { if (original) {
      phase = 'owner-restore-flags'
      const described = await rpc('settings/describe'), row = ownNamespace(described)
      const unchanged = matchesOriginal(row)
      // A read-only run never writes back an external change. An uncertain
      // enable also cannot authorize a compensating replay. A confirmed enable
      // can only undo its own keys while its exact readback revision and both
      // field snapshots remain current; a later owner update is preserved.
      let restoredOwnMutation = false
      const ownedStillCurrent = enableMutation?.confirmed === true && row.revision === enableMutation.revision && matchesSnapshot(row, enableMutation.snapshot)
      if (!probeOnly && enableMutation?.confirmed === true && ownedStillCurrent && !unchanged) {
        if (described.writable !== true) throw Object.assign(Error('VISION_WRITABLE_FEATURE_SETTING_REQUIRED'), { code: 'VISION_WRITABLE_FEATURE_SETTING_REQUIRED' })
        await rpc('settings/mutate', { ns: 'qiuya-tools', expectedRevision: row.revision, ops: original.filter(item => enableMutation.keys.includes(item.key)).map(item => item.own ? { op: 'set', path: [item.key], value: item.value } : { op: 'unset', path: [item.key] }) })
        restoredOwnMutation = true
      }
      const final = ownNamespace(await rpc('settings/describe'))
      restoration.featureFlags = matchesOriginal(final) && (!enableMutation || enableMutation.confirmed === true && ownedStillCurrent)
      if (restoration.featureFlags) restorationProof.featureFlags = restoredOwnMutation ? 'restored-readback' : 'unchanged-readback'
    }
    } catch { failure ??= 'VISION_FEATURE_RESTORE_FAILED' }
    if (!probeOnly && connectionDispatches === 0 && initialConnection && restoration.featureFlags && !restoration.localMode) try {
      phase = 'owner-restore-connection'; const current = connectionView(await computer({ op: 'status' })); restoration.localMode = initialConnection.sessionsKnown && !initialConnection.hasActiveSession && JSON.stringify(current) === JSON.stringify(initialConnection)
      if (restoration.localMode) restorationProof.connection = 'unchanged-no-connect-readback'
    } catch { failure ??= 'VISION_CONNECTION_RESTORE_FAILED' }
    if (!probeOnly && failure && ownedSessions.length === 0 && !setup && ['owner-settings-read', 'owner-enable', 'owner-status'].includes(diagnostic?.phase)) try {
      phase = 'owner-cancel-run'; carrierCancellation = await test({ op: 'cancel-run', phase: diagnostic.phase })
    } catch { carrierCancellation = { requested: true, confirmed: false }; failure ??= 'VISION_CARRIER_CANCEL_UNCONFIRMED' }
    try { phase = 'owner-delivery'; if (testOnlyNaturalEntry && originalAllowedApps !== undefined) checkAllowedApps(await computer({ op: 'status' })); if (!probeOnly) { const receipt = await test({ op: 'delivery', restore: restoration }); if (!receipt.passed) failure ??= 'VISION_DELIVERY_FAILED' } }
    catch { failure ??= 'VISION_DELIVERY_FAILED' }
  }
  const result = { kind: probeOnly ? 'QIUYA_READ_ONLY_OWNER_PROBE' : testOnlyNaturalEntry ? 'QIUYA_REAL_NATURAL_ENTRY_TEST' : 'QIUYA_REAL_VISION_TEST', passed: !probeOnly && !failure && summary.length === 3 && summary.every(task => task.passed) && restoration.localMode && restoration.featureFlags, ...(testOnlyNaturalEntry ? { ownerOnceDriver: '独立测试驱动模拟owner允许一次', humanClickProven: false, naturalEntryTaskIds: [1] } : {}), ...(probeOnly ? { probePassed: !failure && restoration.localMode && restoration.featureFlags, modelInferenceRequested: false, settingsMutationRequested: false } : {}), ...(carrierCancellation ? { carrierCancellation } : {}), enableProof, connectionDispatches, initialConnection: initialConnection ?? null, tasks: summary, restoration, restorationProof, ...(failure ? { error: failure, diagnostic: diagnostic ?? projectVisionFailure({ code: failure }, phase) } : {}) }
  emit(result); return result
}
