/** Test-only budget for a complete, multi-turn model/computer-tool pipeline. */
export const HARNESS_COMPUTER_PIPELINE_MS = 90_000
const interrupted = new Set(['paused', 'pausing', 'humanControl', 'handingOver', 'stopping', 'stopped', 'faulted', 'disconnected'])
const stages = new Set(['awaiting-session', 'model-turn', 'image-received', 'action-received', 'verified-image', 'complete'])
const states = new Set(['idle', 'connecting', 'awaitingPermission', 'ready', 'running', 'pausing', 'paused', 'handingOver', 'humanControl', 'resuming', 'stopping', 'stopped', 'disconnected', 'faulted'])

/** A failed case may not leak its Agent/tool turn into later UI cases. */
export function harnessFailedComputerDrained(value, sessionId, started = true) {
  return value?.agent?.sessionId === sessionId && value.agent.available === true && value.agent.state === 'idle' &&
    value.agent.nextTurn === 0 && value.agent.nextStep === 0 && value.pending === 0 &&
    (started === false ? value.computer === null : value.computer?.sessionId === sessionId && value.computer.state === 'stopped')
}

/** A failed native retirement must not prevent other owned resources retiring. */
export async function finalizeHarnessOwnedResources(stages) {
  const errors = []
  for (const stage of stages) {
    try { await stage.run() }
    catch (error) { errors.push({ stage: stage.name, code: ['NATIVE_CLEANUP_FAILED', 'NATIVE_TIMEOUT', 'NATIVE_EXITED'].includes(error?.code) ? error.code : 'OWNED_CLEANUP_FAILED' }) }
  }
  return errors
}

/** The settings task list deliberately removes stopped sessions. */
export function matchesHarnessPreviewControlState(value, expectedState) {
  if (!['paused', 'ready', 'humanControl', 'stopped'].includes(expectedState)) return false
  if (value?.settingsVisible !== true || value?.backendState !== expectedState) return false
  if (expectedState === 'stopped') return value.taskCount === 0 && value.taskState === null
  return value.taskCount === 1 && value.taskState === expectedState
}

export async function waitForHarnessComputerPipeline(read, { now = Date.now, sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds)), onProgress = () => {} } = {}) {
  const start = now(), deadline = start + HARNESS_COMPUTER_PIPELINE_MS
  while (now() < deadline) {
    const value = await read(Math.max(1, deadline - now()))
    const elapsedMs = now() - start
    // Persist only the finite projection; never retain exception messages,
    // model text, paths, screenshots or raw driver/status records here.
    const progress = { elapsedMs, stage: stages.has(value?.stage) ? value.stage : 'model-turn', state: states.has(value?.state) ? value.state : null,
      turns: Number.isSafeInteger(value?.turns) && value.turns >= 0 && value.turns <= 10000 ? value.turns : null,
      hasImage: value?.hasImage === true, hasAction: value?.hasAction === true }
    await onProgress(progress)
    if (now() >= deadline) break
    if (interrupted.has(value?.state) || value?.failed === true || value?.nativeAvailable === false) throw new Error(`The authorized computer pipeline stopped before verification (${progress.state ?? 'tool-or-native-failure'}); no input was replayed`)
    if (value?.complete === true) return progress
    await sleep(Math.min(250, Math.max(0, deadline - now())))
  }
  throw new Error(`The multi-turn computer pipeline did not complete within ${HARNESS_COMPUTER_PIPELINE_MS} ms; no input was replayed`)
}

/** Bind normal WM_CLOSE cleanup to this run's actual native session windows.
 * The Windows observer rechecks the original process/parent/window identities;
 * this projection never authorizes a path prefix or an arbitrary desktop HWND. */
export function createHarnessWindowsSessionCloseRequest({ host, hostExecutable, hostSHA256, profileRoot, architecture, nativeExecutable, nativeSHA256, windows }) {
  const fail = () => { throw new Error('The normal window close must bind this exact live isolated Host and session windows') }
  if (!Number.isSafeInteger(host?.pid) || host.pid < 1 || host.exitCode !== null || host.signalCode !== null ||
    !['arm64', 'x64'].includes(architecture) || !/^[a-f0-9]{64}$/u.test(nativeSHA256 ?? '') || !/^[a-f0-9]{64}$/u.test(hostSHA256 ?? '') ||
    !/^[a-z]:\\[^\x00-\x1f]+$/iu.test(hostExecutable ?? '') || !/^[a-z]:\\[^\x00-\x1f]+\\qiuya-harness-e2e-[a-zA-Z0-9]{6}\\qiuya-harness-home$/iu.test(profileRoot ?? '') ||
    nativeExecutable?.toLowerCase() !== `${profileRoot}\\profiles\\web\\node_modules\\dsh-qiuya-tools\\lib\\native\\win32-${architecture}\\qiuya-windows.exe`.toLowerCase() ||
    !Array.isArray(windows) || windows.length < 1 || windows.length > 2) fail()
  const seen = new Set(), sessions = new Set(); let helperPID, helperBirthTicks
  const projected = windows.map(({ sessionId, title, target }) => {
    const match = /^window:([a-f0-9]+):(\d+):(\d+)$/iu.exec(target?.id ?? '')
    if (!match || !Number.isSafeInteger(target.pid) || target.pid < 1 || String(target.pid) !== match[2] ||
      !/^session-[a-zA-Z0-9-]+$/u.test(sessionId ?? '') || !/^E2E:(Alpha|Beta)-[a-zA-Z0-9]+$/u.test(title ?? '') ||
      target.title !== title + ' — QiuYaTools' || target.appId?.toLowerCase() !== nativeExecutable.toLowerCase() ||
      seen.has(target.id) || sessions.has(sessionId) || helperPID !== undefined && (helperPID !== target.pid || helperBirthTicks !== match[3])) fail()
    seen.add(target.id); sessions.add(sessionId); helperPID = target.pid; helperBirthTicks = match[3]
    return { sessionId, targetId: target.id, title: target.title }
  })
  return { version: 1, operation: 'normal-close-owned-session-windows', hostPID: host.pid, hostExecutable, hostSHA256, profileRoot, architecture, nativeExecutable, nativeSHA256, helperPID, helperBirthTicks, windows: projected, budgetMs: 5000 }
}
