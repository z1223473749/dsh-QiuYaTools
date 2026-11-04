export function matchTab(windows, identity) {
  const geometry = identity.window
  const candidates = windows.filter(window => ['left', 'top', 'width', 'height'].every(key => Math.abs(window[key] - geometry[key]) <= 2))
  if (candidates.length !== 1) return
  const tabs = (candidates[0].tabs ?? []).filter(tab => tab.title === identity.title)
  return tabs.length === 1 ? tabs[0] : undefined
}

export function createTaskGroups(api, now = Date.now) {
  const groups = new Map(), ownedOpeners = new Map()
  async function applyGroup(command) {
    if (typeof command.id !== 'string' || typeof command.operation !== 'string' || typeof command.label !== 'string' || command.label.length > 120 || !command.tab || now() >= command.expiresAt) return { id: command.id, status: 'unavailable' }
    let windows
    try { windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] }) } catch { return { id: command.id, status: 'unavailable' } }
    const tab = matchTab(windows, command.tab)
    if (!tab || tab.pinned || now() >= command.expiresAt) return { id: command.id, status: 'ambiguous' }
    const key = command.operation + ':' + tab.windowId
    let owned = groups.get(key)
    if (owned) {
      try { const group = await api.tabGroups.get(owned.id); if (group.title !== owned.title) return { id: command.id, status: 'ambiguous' } } catch { groups.delete(key); owned = undefined }
    }
    // Preserve a group made by the user or a different task. Never rename it.
    if (tab.groupId !== -1 && tab.groupId !== owned?.id) return { id: command.id, status: 'ambiguous' }
    // Re-read the exact tab immediately before mutation. Navigation/reorder can
    // otherwise race the window query while a user is using the browser.
    let current
    try { current = await api.tabs.get(tab.id) } catch { return { id: command.id, status: 'ambiguous' } }
    if (current.windowId !== tab.windowId || current.title !== command.tab.title || current.groupId !== tab.groupId || now() >= command.expiresAt) return { id: command.id, status: 'ambiguous' }
    let dispatched = false
    try {
      dispatched = true
      const id = await api.tabs.group({ tabIds: [tab.id], ...(owned ? { groupId: owned.id } : { createProperties: { windowId: tab.windowId } }) })
      groups.set(key, { id, title: command.label, expiresAt: now() + 60_000 })
      await api.tabGroups.update(id, { title: command.label, color: 'pink', collapsed: false })
      ownedOpeners.set(tab.id, { groupId: id, title: command.label, operation: command.operation, expiresAt: now() + 60_000 })
      const result = await api.tabs.get(tab.id), group = await api.tabGroups.get(id)
      return { id: command.id, status: result.groupId === id && group.title === command.label ? 'grouped' : 'unconfirmed' }
    } catch { return { id: command.id, status: dispatched ? 'unconfirmed' : 'unavailable' } }
  }

  // Only children of a currently operated tab inherit the group. A user's
  // unrelated new tab has no matching opener and remains outside the task.
  async function onCreated(tab) {
    const owner = ownedOpeners.get(tab.openerTabId)
    if (!owner || owner.expiresAt < now() || tab.pinned) return
    try {
      const opener = await api.tabs.get(tab.openerTabId), group = await api.tabGroups.get(owner.groupId)
      if (ownedOpeners.get(tab.openerTabId) !== owner || owner.expiresAt < now() || opener.groupId !== owner.groupId || group.title !== owner.title || group.windowId !== tab.windowId) return
      await api.tabs.group({ tabIds: [tab.id], groupId: owner.groupId })
      ownedOpeners.set(tab.id, { ...owner })
    } catch { /* Browser changes invalidate inheritance; never replay it. */ }
  }

  function end(operations) { for (const [id, owner] of ownedOpeners) if (operations.includes(owner.operation)) ownedOpeners.delete(id) }
  return { applyGroup, onCreated, removed: id => ownedOpeners.delete(id), end, disconnect: () => { ownedOpeners.clear(); groups.clear() } }
}
