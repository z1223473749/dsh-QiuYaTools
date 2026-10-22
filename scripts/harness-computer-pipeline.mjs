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
