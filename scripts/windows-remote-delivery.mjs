/** Test-only evidence validation; never mutates a process or input state. */
export function windowsRemoteNaturalExitPassed(audit, expected) {
  if (!audit || audit.passed !== true || audit.terminate !== false || !Array.isArray(audit.errors) || audit.errors.length || !Array.isArray(audit.results) || !Array.isArray(expected) || !expected.length || audit.results.length !== expected.length) return false
  const seen = new Set()
  for (const row of expected) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.createdAtTicks !== 'string' || !/^[1-9][0-9]+$/u.test(row.createdAtTicks) || typeof row.expectedExecutablePath !== 'string' || !/^[a-z]:[\\/]/iu.test(row.expectedExecutablePath) || seen.has(row.pid)) return false
    seen.add(row.pid)
  }
  for (const row of audit.results) if (!row || !['already-exited', 'reused-pid-skipped'].includes(row.state) || !seen.delete(row.pid)) return false
  return seen.size === 0
}
export function windowsRemoteDesktopReleased(state) {
  return state?.userInteractive === true && Number.isSafeInteger(state.sessionId) && state.sessionId > 0 && state.activeDesktopAccessible === true && state.activeDesktopMatches === true && state.heldKeyCount === 0 && state.leaseScopeExists === true && state.leaseFree === true && state.journalPresent === false
}
export function windowsRemoteDeferredRetirementCovered(deferred, expected) {
  if (!Array.isArray(deferred) || !Array.isArray(expected)) return false
  const runners = expected.filter(row => row?.role === 'runner')
  if (runners.length !== 1) return false
  const required = expected.filter(row => row?.role === 'runner' || row?.role === 'console' && row.parentPid === runners[0].pid)
  if (required.length !== deferred.length) return false
  return required.every(row => deferred.filter(item => item?.pid === row.pid && item.role === row.role && item.createdAtTicks === row.createdAtTicks && item.expectedExecutablePath === row.expectedExecutablePath && item.parentPid === row.parentPid).length === 1)
}
export function windowsRemoteDeliveryPassed({ businessPassed, cleanup, expectedIdentities }) {
  if (!Array.isArray(expectedIdentities)) return false
  const empty = value => Array.isArray(value) && value.length === 0
  const roles = new Set(expectedIdentities.map(row => row?.role))
  const coverage = ['runner', 'fixture', 'agent', 'native', 'relay', 'guardian', 'capture'].every(role => roles.has(role))
  return businessPassed === true && coverage && empty(cleanup?.errors) && empty(cleanup?.forced) && cleanup?.guest?.passed === true && empty(cleanup.guest.errors) && empty(cleanup.guest.forced) && cleanup.guest.agent?.passed === true && cleanup.guest.agent.nativeExit?.code === 0 && cleanup.guest.agent.nativeExit?.signal === null && cleanup.guest.agent.oldTokenRejected === true && cleanup.guest.secretsDeleted === true && cleanup.bindingPolicySelfTest?.passed === true && cleanup.bindingPolicySelfTest.checks === 11 && windowsRemoteDeferredRetirementCovered(cleanup.guest.deferredUntilOuterVerification, expectedIdentities) && cleanup.task?.state === 'Ready' && cleanup.task.result === 0 && cleanup.task.unregistered === true && cleanup.task.stopRequired === false && windowsRemoteDesktopReleased(cleanup.guest.finalDesktop) && windowsRemoteNaturalExitPassed(cleanup.processes, expectedIdentities)
}
