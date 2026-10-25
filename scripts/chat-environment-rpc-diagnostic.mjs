/** Test-only correlation: narrowly classify a readonly pending poll during an explicit owner connection. */
export function createChatEnvironmentRPCDiagnostic({ knownSession, now = () => performance.now() }) {
  const requests = new Map(), connects = [], expectedSwitching = []
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value)
  const scope = value => value.sessionId && `${value.sessionId}\n${value.taskId ?? ''}`
  const copy = row => ({ ...row })
  return {
    begin(key, envelope, surface) {
      const payload = envelope?.payload
      if (!payload || typeof payload.op !== 'string') return
      const row = { op: payload.op, surface, ...(identity(payload.sessionId) ? { sessionId: payload.sessionId } : {}), ...(identity(payload.taskId) ? { taskId: payload.taskId } : {}), ...(identity(envelope.rpcId) ? { rpcId: envelope.rpcId } : {}), issuedAtMs: now() }
      requests.set(key, row)
      if (row.op === 'connect' && row.surface === 'chat' && row.sessionId && knownSession(row.sessionId) && payload.mode === 'browser') { row.ownerConnect = true; connects.push(row) }
    },
    finish(key, result, receivedAtMs = now()) {
      const row = requests.get(key)
      if (!row) return undefined
      row.receivedAtMs = receivedAtMs; row.outcome = result?.ok === true ? 'succeeded' : result?.ok === false ? 'failed' : 'invalid-response'
      if (result?.ok !== false) return undefined
      const error = { op: row.op, ...(row.sessionId ? { sessionId: row.sessionId } : {}), ...(row.taskId ? { taskId: row.taskId } : {}), ...(row.rpcId ? { rpcId: row.rpcId } : {}), code: result.error?.code, message: result.error?.message ?? 'RPC failed', issuedAtMs: row.issuedAtMs, receivedAtMs }
      const connection = row.op === 'pending' && row.surface === 'chat' && row.sessionId && knownSession(row.sessionId)
        && error.code === 'COMPUTER_FAILED' && error.message === '正在切换操作环境，请稍候。'
        ? connects.find(item => scope(item) === scope(row) && item !== row && item.issuedAtMs <= receivedAtMs && (item.receivedAtMs ?? Infinity) >= row.issuedAtMs) : undefined
      if (!connection) return { expected: false, error }
      const witness = { ...error, classification: 'expected-readonly-pending-during-owner-connect', ownerConnect: { op: connection.op, sessionId: connection.sessionId, ...(connection.taskId ? { taskId: connection.taskId } : {}), ...(connection.rpcId ? { rpcId: connection.rpcId } : {}), issuedAtMs: connection.issuedAtMs, ...(connection.receivedAtMs === undefined ? { outcome: 'in-flight' } : { receivedAtMs: connection.receivedAtMs, outcome: connection.outcome }) } }
      expectedSwitching.push(witness)
      return { expected: true, error: witness }
    },
    failed(key) { const row = requests.get(key); if (row) { row.receivedAtMs = now(); row.outcome = 'response-unconfirmed' } },
    snapshot() { return { expectedSwitching: expectedSwitching.map(row => ({ ...row, ownerConnect: copy(row.ownerConnect) })), ownerConnections: connects.map(copy), savedRequestBodies: false, savedCredentials: false } },
  }
}

/** Test-owned raw browser only. These flags never alter the candidate or its production launcher. */
export function ownedBrowserRenderingPlan(args = []) {
  for (const flag of ['--stable-owned-rendering', '--raw-owned-cdp', '--preserve-owned-cdp-compression']) if (args.filter(value => value === flag).length > 1) throw new Error('Duplicate owned-browser diagnostic option')
  const stableOwnedRendering = args.includes('--stable-owned-rendering'), rawOwnedCDP = args.includes('--raw-owned-cdp'), preserveOwnedCDPCompression = args.includes('--preserve-owned-cdp-compression')
  if (rawOwnedCDP && preserveOwnedCDPCompression) throw new Error('Raw CDP cannot also request the observation proxy')
  return { stableOwnedRendering, rawOwnedCDP, preserveOwnedCDPCompression, browserArguments: stableOwnedRendering ? ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] : [] }
}
export function assertNoWorkbenchPreviewTimeouts(errors) {
  const count = errors.filter(error => error?.code === 'BROWSER_TIMEOUT').length
  if (count) throw new Error(`Installed workbench recorded ${count} BROWSER_TIMEOUT responses; intermittent preview frames are not a successful realtime acceptance`)
  const unexpected = errors.filter(error => error?.code !== 'CONTROL_CHANGED').length
  if (unexpected) throw new Error(`Installed workbench recorded ${unexpected} unexpected error responses; later frames cannot confirm a successful realtime acceptance`)
  return { observedBrowserTimeouts: 0, transientControlChanged: errors.filter(error => error?.code === 'CONTROL_CHANGED').length }
}

/** Private acceptance evidence: identities and timing only, never request/body data. */
export function workbenchRPCMetadata(envelope, issuedAtMs, receivedAtMs, result, taskId) {
  const payload = envelope?.payload, row = { issuedAtMs }
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9:_-]+$/u.test(value)
  for (const [name, value] of [['rpcId', envelope?.rpcId], ['chatSessionId', payload?.chatSessionId], ['environmentId', payload?.environmentId], ['workbenchTabId', payload?.workbenchTabId], ['taskId', taskId]]) if (identity(value)) row[name] = value
  if (['status', 'permissions', 'preview', 'navigation', 'control', 'humanAct', 'decide', 'open', 'closeEnvironment'].includes(payload?.op)) row.op = payload.op
  if (payload?.op === 'control' && ['pause', 'takeover', 'resume', 'stop'].includes(payload?.operation)) row.operation = payload.operation
  if (receivedAtMs !== undefined) row.receivedAtMs = receivedAtMs
  if (typeof result?.ok === 'boolean') row.ok = result.ok
  if (result?.ok === false && typeof result.error?.code === 'string' && /^[A-Z_]{1,64}$/u.test(result.error.code)) row.code = result.error.code
  return row
}

/** Every received own RPC body must finish parsing before a green report. */
export function createRPCResponseCollector() {
  const pending = new Set(), failures = []
  let received = 0, decoded = 0
  return {
    collect(metadata, read) {
      received++
      const job = Promise.resolve().then(read).then(() => { decoded++ }, () => { failures.push({ channel: metadata.channel, op: metadata.op, code: 'RPC_RESPONSE_UNCONFIRMED' }) }).finally(() => pending.delete(job))
      pending.add(job)
      return job
    },
    snapshot() { return { received, decoded, pending: pending.size, failures: failures.map(row => ({ ...row })), savedResponseBodies: false } },
    async drain(budgetMs = 15000) {
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 15000) throw new Error('Invalid response-drain budget')
      let timer
      try {
        await Promise.race([(async () => { while (pending.size) await Promise.all([...pending]) })(), new Promise((_, reject) => { timer = setTimeout(() => { failures.push({ channel: 'collection', code: 'RPC_RESPONSE_DRAIN_TIMEOUT' }); reject(new Error('Own RPC responses did not drain within their original budget')) }, budgetMs) })])
      } finally { clearTimeout(timer) }
      if (failures.length) throw new Error('Own RPC response bodies were unconfirmed; zero-timeout acceptance is unavailable')
      if (pending.size || decoded !== received) throw new Error('Own RPC response completeness is unconfirmed')
      return this.snapshot()
    },
  }
}
