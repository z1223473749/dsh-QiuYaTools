/** Host identities and memberships are authoritative; titles are presentation only. */
export interface ArchiveTarget {
  readonly id: string
  readonly title: string
}

export interface SidebarArchiveCatalog {
  readonly sessions: readonly (ArchiveTarget & { readonly blank: boolean; readonly origin?: string })[]
  readonly workspaces: readonly { readonly workspaceId: string; readonly sessionIds: readonly string[] }[]
  readonly archivedSessionIds: readonly string[]
}

export function sidebarArchiveTargets(catalog: SidebarArchiveCatalog): Map<string, readonly ArchiveTarget[]> {
  const archived = new Set(catalog.archivedSessionIds)
  const sessions = new Map(catalog.sessions
    .filter(session => !session.blank && session.origin !== 'subagent' && !archived.has(session.id))
    .map(session => [session.id, { id: session.id, title: session.title }] as const))
  const targets = new Map<string, readonly ArchiveTarget[]>()
  for (const session of sessions.values()) targets.set(`session:${session.id}`, [session])
  const accounted = new Set<string>()
  for (const workspace of catalog.workspaces) {
    workspace.sessionIds.forEach(id => accounted.add(id))
    targets.set(`workspace:${workspace.workspaceId}`, [...new Set(workspace.sessionIds)].flatMap(id => {
      const session = sessions.get(id)
      return session === undefined ? [] : [session]
    }))
  }
  targets.set('workspace:', [...sessions.values()].filter(session => !accounted.has(session.id)))
  return targets
}

/** A fixed anchor makes repeated Shift clicks extend or shrink the same visible range. */
export class SidebarSelection {
  readonly selected = new Map<string, ArchiveTarget>()
  anchorId: string | undefined

  clear(): void {
    this.selected.clear()
    this.anchorId = undefined
  }

  anchor(member: ArchiveTarget | undefined): void {
    this.clear()
    this.anchorId = member?.id
  }

  toggle(member: ArchiveTarget): void {
    if (this.selected.has(member.id)) this.selected.delete(member.id)
    else this.selected.set(member.id, member)
    this.anchorId = member.id
  }

  range(member: ArchiveTarget, visible: readonly ArchiveTarget[]): void {
    const end = visible.findIndex(item => item.id === member.id)
    if (end < 0) return
    const anchor = visible.findIndex(item => item.id === this.anchorId)
    const start = anchor < 0 ? end : anchor
    this.selected.clear()
    for (const item of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      this.selected.set(item.id, item)
    }
    if (anchor < 0) this.anchorId = member.id
  }

  reconcile(targets: ReadonlyMap<string, readonly ArchiveTarget[]>): void {
    const current = new Map([...targets.values()].flatMap(items => items.map(item => [item.id, item] as const)))
    for (const id of this.selected.keys()) {
      const member = current.get(id)
      if (member === undefined) this.selected.delete(id)
      else this.selected.set(id, member)
    }
  }
}
