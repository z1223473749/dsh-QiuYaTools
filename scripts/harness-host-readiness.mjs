/** Test-only public Host bootstrap budget, shared with the installed UI runner. */
export const HARNESS_HOST_STARTUP_MS = 90_000

export async function waitForHarnessHostUrl(read, { now = Date.now, sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds)) } = {}) {
  const until = now() + HARNESS_HOST_STARTUP_MS
  while (now() < until) {
    const state = read()
    if (state.exited) throw new Error(state.error || 'The actual installed Harness Host exited before becoming ready')
    if (state.url) return state.url
    await sleep(100)
  }
  throw new Error(`The actual installed Harness Host did not become ready within ${HARNESS_HOST_STARTUP_MS} ms`)
}
