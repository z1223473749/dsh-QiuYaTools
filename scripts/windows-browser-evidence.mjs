/** Strict, independent verdict for an immutable installed-browser selection. */
export function assessBrowserDelivery(report, browser) {
  const selected = browser === 'all' ? ['chrome', 'edge'] : ['chrome', 'edge'].includes(browser) ? [browser] : []
  const rows = Array.isArray(report?.checks) ? report.checks : []
  const selectionMatches = selected.length > 0 && Array.isArray(report?.selectedBrowsers) &&
    JSON.stringify(report.selectedBrowsers) === JSON.stringify(selected) && rows.length === selected.length &&
    rows.every((row, index) => row.browser === selected[index])
  const individual = selected.map(name => {
    const matches = rows.filter(row => row.browser === name)
    const row = matches.length === 1 ? matches[0] : undefined
    const passed = Boolean(row?.status === 'passed' && row.passed === true && row.actualBrowser === true &&
      row.checks === 10 && row.naturalNodeExit === true && row.nodeExitCode === 0 && !row.reason &&
      row.identity?.pid > 0 && typeof row.identity?.createdAtTicks === 'string' &&
      typeof row.identity?.executable === 'string' && row.identity?.sessionId > 0)
    return { browser: name, status: row?.status ?? 'not-run', passed, checks: row?.checks ?? 0, reason: row?.reason ?? (row ? null : 'Independent browser result missing') }
  })
  const cleanupPassed = report?.cleanup?.forcedNodeTermination === false && report?.cleanup?.processSignalSent === false &&
    Array.isArray(report.cleanup.remainingNodeProcesses) && report.cleanup.remainingNodeProcesses.length === 0
  return { passed: Boolean(report?.passed === true && selectionMatches && individual.every(row => row.passed) &&
    cleanupPassed && !report?.error), selected, selectionMatches, individual, cleanupPassed }
}

/** Resume only the assigned paused VM; restore its original idle policy outside. */
export async function prepareBrowserVm(invoke, vm, record = () => {}) {
  const initial = (await invoke(['list', '--info', vm])).stdout
  const originalPauseIdle = /Pause idle: (on|off)/u.exec(initial)?.[1]
  const initialState = /^State:\s*(running|paused)\s*$/imu.exec(initial)?.[1]?.toLowerCase()
  if (!originalPauseIdle || !initialState) throw new Error('Assigned VM must be running or paused with readable idle policy')
  const state = { initialState, originalPauseIdle, resumeRequested: false, resumed: false, runningConfirmed: false }
  record({ ...state })
  await invoke(['set', vm, '--pause-idle', 'off'])
  if (initialState === 'paused') {
    state.resumeRequested = true; record({ ...state })
    await invoke(['resume', vm])
    state.resumed = true; record({ ...state })
  }
  const current = (await invoke(['list', '--info', vm])).stdout
  if (!/^State:\s*running\s*$/imu.test(current)) throw new Error('Assigned VM did not become running')
  state.runningConfirmed = true; record({ ...state })
  return state
}
