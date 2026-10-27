interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface SessionCatalog { phase: string; byId: Readonly<Record<string, { cwd?: string; origin?: string }>> }
interface IndicatorOptions {
  sessions: Source<SessionCatalog>
  enabled(): boolean
  label(pending: boolean): string
  subscribe(listener: () => void): () => void
}

export const WORKTREE_ICON_PATH = 'M3 12.5h7.5V5M6.5 5h4V9M5 3H2v3M10.5 5 3 12.5'
const ROW = '[data-slot="sidebar.workspaces"] [data-row-key^="session:"]'
// createWorktree owns this directory layout. The catalog preserves cwd across
// reloads, so decorating a row never needs to activate its Session or poll Git.
const managedWorktree = (cwd: string | undefined): boolean => typeof cwd === 'string'
  && /\/qiuya-git\/worktrees\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}(?:\/|$)/iu.test(cwd.replace(/\\/gu, '/'))

/** The Host has no persistent trailing decoration slot; its action slot is hover-only. */
export function installGitWorktreeIndicators(options: IndicatorOptions, doc: Document = document) {
  const win = doc.defaultView, pending = new Set<string>(), badges = new Map<HTMLElement, HTMLSpanElement>()
  let disposed = false, scheduled = false
  const render = () => {
    if (disposed) return
    const catalog = options.sessions.getSnapshot(), active = new Set<HTMLElement>()
    if (options.enabled() && catalog.phase === 'ready') for (const row of doc.querySelectorAll<HTMLElement>(ROW)) {
      const id = row.dataset.rowKey?.slice('session:'.length) ?? '', session = catalog.byId[id]
      if (!session || session.origin === 'subagent' || !pending.has(id) && !managedWorktree(session.cwd)) continue
      active.add(row)
      let badge = badges.get(row)
      if (!badge) {
        badge = doc.createElement('span')
        badge.className = 'qyt-git-worktree-indicator'
        badge.setAttribute('role', 'img')
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
        for (const [key, value] of Object.entries({ width: '15', height: '15', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'aria-hidden': 'true' })) svg.setAttribute(key, value)
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', WORKTREE_ICON_PATH)
        svg.append(path); badge.append(svg); badges.set(row, badge)
      }
      const label = options.label(pending.has(id) && !managedWorktree(session.cwd))
      if (badge.dataset.qytGitWorktree !== id) badge.dataset.qytGitWorktree = id
      if (badge.title !== label) { badge.title = label; badge.setAttribute('aria-label', label) }
      // A sibling of the time and action bar stays visible both at rest and on hover.
      if (badge.parentElement !== row) row.append(badge)
    }
    for (const [row, badge] of badges) if (!active.has(row)) { badge.remove(); badges.delete(row) }
  }
  const schedule = () => {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; render() })
  }
  const observer = win ? new win.MutationObserver(schedule) : undefined
  const disposers: (() => void)[] = []
  const dispose = () => {
    if (disposed) return
    disposed = true; observer?.disconnect()
    for (const off of disposers.reverse()) off()
    for (const badge of badges.values()) badge.remove()
    badges.clear(); pending.clear()
  }
  try {
    disposers.push(options.sessions.subscribe(schedule))
    disposers.push(options.subscribe(schedule))
    observer?.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'data-slot'] })
    render()
  } catch (error) { dispose(); throw error }
  return {
    setPending(sessionId: string, value: boolean) { if (disposed) return; if (value) pending.add(sessionId); else pending.delete(sessionId); schedule() },
    dispose,
  }
}
