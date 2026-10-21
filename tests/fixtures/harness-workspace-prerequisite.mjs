/** Public Harness workspace setup for disposable-profile UI tests. */
export function sanitizeHarnessDiagnostic(message) {
  return String(message).replace(/https?:\/\/[^\s"'<>]+/giu, value => {
    try { const url = new URL(value); return url.origin + url.pathname } catch { return '<URL redacted>' }
  }).replace(/([?&]token=)[^&\s"'<>]+/giu, '$1<redacted>')
}

/** Observe the initial same-origin navigation without waiting for every asset's load event. */
export async function navigateHarnessPage(page, url, record) {
  const origin = new URL(url).origin, start = Date.now(), pending = new Map(), completed = []
  const describe = request => {
    const parsed = new URL(request.url())
    return parsed.origin === origin ? { path: parsed.pathname, resourceType: request.resourceType(), startedAfterMs: Date.now() - start } : undefined
  }
  const started = request => { const detail = describe(request); if (detail) pending.set(request, detail) }
  const finished = request => {
    const detail = pending.get(request); pending.delete(request)
    if (detail && completed.length < 64) completed.push({ ...detail, finishedAfterMs: Date.now() - start, ...(request.failure() ? { reason: sanitizeHarnessDiagnostic(request.failure().errorText) } : {}) })
  }
  page.on('request', started); page.on('requestfinished', finished); page.on('requestfailed', finished)
  let error
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }) }
  catch (failure) { error = sanitizeHarnessDiagnostic(failure.message); throw failure }
  finally {
    page.off('request', started); page.off('requestfinished', finished); page.off('requestfailed', finished)
    const document = await page.evaluate(() => ({ readyState: globalThis.document.readyState })).catch(failure => ({ error: sanitizeHarnessDiagnostic(failure.message) }))
    await record({ milestone: 'domcontentloaded', elapsedMs: Date.now() - start, document, pendingSameOrigin: [...pending.values()].slice(0, 64), completedSameOrigin: completed, ...(error ? { error } : {}), boundary: 'Only same-origin URL paths; query/hash/auth values and foreign origins are excluded. Public UI and workspace readiness retain their existing 15-second checks.' })
  }
}

export function captureHarnessWorkspaceDom() {
  const visible = element => !!element?.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'
  return {
    conversations: [...document.querySelectorAll('[data-conversation-content]')].map(element => ({
      sessionId: element.getAttribute('data-conversation-session'), phase: element.getAttribute('data-content-phase'), visible: visible(element),
      composers: [...element.querySelectorAll('[data-composer-input]')].map(input => ({ editable: input.getAttribute('contenteditable'), phase: input.getAttribute('data-phase'), visible: visible(input), textLength: input.textContent?.length ?? 0, placeholder: input.getAttribute('data-placeholder') ?? input.getAttribute('aria-label') })),
    })),
    rows: [...document.querySelectorAll('[data-row-key]')].map(element => ({ key: element.getAttribute('data-row-key'), selected: element.getAttribute('aria-selected'), draggable: element.draggable, visible: visible(element) })),
    workspaceChips: [...document.querySelectorAll('button[aria-haspopup="menu"][aria-label="选择工作区"]')].map(element => ({ text: element.textContent?.trim(), visible: visible(element), expanded: element.getAttribute('aria-expanded') })),
  }
}

/** One documented owner RPC; the page's existing Connection authentication is used unchanged. */
export async function registerHarnessWorkspace(page, path) {
  return page.evaluate(async path => {
    const rpcId = crypto.randomUUID(), method = 'workspace/create'
    const response = await fetch('/api/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request: { path } } } }),
    })
    if (!response.ok) throw new Error('Own workspace registration HTTP ' + response.status)
    const envelope = await response.json()
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) throw new Error('Own workspace registration returned an uncorrelated response')
    if (envelope.result?.ok !== true) throw new Error('Own workspace registration failed: ' + (envelope.result?.error?.code ?? 'invalid-response'))
    const value = envelope.result.value, workspace = value?.workspace
    if (!workspace || workspace.path !== path || typeof workspace.workspaceId !== 'string' || !workspace.workspaceId || typeof workspace.title !== 'string' || !workspace.title || !Array.isArray(workspace.sessionIds)) throw new Error('Own workspace registration returned a different directory or invalid identity')
    return { workspaceId: workspace.workspaceId, path: workspace.path, title: workspace.title, created: value.created === true }
  }, path)
}

/** Only the selected public hero/row and the explicitly picked workspace establish readiness. */
export function selectedHarnessWorkspaceSession(snapshot, workspace) {
  if (!snapshot.rows.some(row => row.key === 'workspace:' + workspace.workspaceId && row.visible)) return
  if (!snapshot.workspaceChips.some(chip => chip.visible && chip.text === workspace.title)) return
  const hero = snapshot.conversations.find(item => item.visible && item.phase === 'hero' && item.sessionId)
  if (!hero || !snapshot.rows.some(row => row.visible && row.key === 'session:' + hero.sessionId && row.selected === 'true' && !row.draggable)) return
  if (!hero.composers.some(input => input.visible && input.editable === 'true' && input.textLength === 0)) return
  return hero.sessionId
}
