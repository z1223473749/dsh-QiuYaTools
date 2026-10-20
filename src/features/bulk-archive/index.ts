import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { installSidebarBulkArchive } from './dom.ts'
import { sidebarArchiveTargets } from './model.ts'
import { BULK_ARCHIVE_NS, bulkArchiveEn, bulkArchiveZh } from './locales.ts'

/** The caller owns this disposer and may toggle the feature without reloading Harness. */
export function installBulkArchive(ctx: Context): () => void {
  const stopLocale = ctx.locale.register(BULK_ARCHIVE_NS, { zh: bulkArchiveZh, en: bulkArchiveEn })
  let stopDom: (() => void) | undefined
  try {
    stopDom = installSidebarBulkArchive({
      targets: () => {
        const sessions = ctx.sessions.list.getSnapshot()
        const workspaces = ctx.workspaces.list.getSnapshot()
        return sidebarArchiveTargets({
          sessions: sessions.ids.flatMap(id => {
            const session = sessions.byId[id]
            return session === undefined ? [] : [{
              id: session.id, title: session.displayTitle, blank: session.blank, origin: session.origin,
            }]
          }),
          workspaces: workspaces.items,
          archivedSessionIds: workspaces.archivedSessionIds,
        })
      },
      archive: async id => { await ctx.uiWorkspace.archiveSession(id as SessionId) },
      subscribe: refresh => {
        const stopSessions = ctx.sessions.list.subscribe(refresh)
        const stopWorkspaces = ctx.workspaces.list.subscribe(refresh)
        const stopLanguage = ctx.locale.subscribe(refresh)
        return () => { stopLanguage(); stopWorkspaces(); stopSessions() }
      },
      t: ctx.locale.bind(BULK_ARCHIVE_NS),
    })
  } catch (cause) {
    stopDom?.()
    stopLocale()
    throw cause
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    stopDom?.()
    stopLocale()
  }
}
