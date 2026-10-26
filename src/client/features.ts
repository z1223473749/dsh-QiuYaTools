import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_PREFERENCES, type FeatureField, type Preferences } from '../shared.ts'
import { FeatureSwitchboard } from './feature-switchboard.ts'
import { installPastedText } from '../features/pasted-text/index.tsx'
import { installBulkArchive } from '../features/bulk-archive/index.ts'
import { installSessionWindows } from '../features/session-windows/index.tsx'
import { installPlanComments } from '../features/plan-comments/index.tsx'
import { installConversationComments } from '../features/conversation-comments/index.tsx'
import { installSidebarTools } from '../features/sidebar-tools/index.tsx'
import { installPromptSuggestions } from '../features/prompt-suggestions/index.tsx'
import { effectiveSessionWindowPreferences, getSessionWindowSupport } from './session-window-support.ts'

const dependencies: Record<FeatureField, string[]> = {
  pastedTextEnabled: ['slots'],
  sessionWindowsEnabled: ['slots'],
  bulkArchiveEnabled: ['locale', 'sessions', 'workspaces', 'uiWorkspace'],
  planCommentsEnabled: ['slots', 'locale', 'sessions', 'sidebarRight'],
  conversationCommentsEnabled: ['slots', 'locale', 'sessions', 'conversation', 'uiSession', 'uiWorkspace', 'workspaces'],
  sidebarToolsEnabled: ['slots', 'sessions', 'workspaces', 'uiSession'],
  promptSuggestionsEnabled: ['slots', 'locale', 'connection', 'uiSession'],
}

/** The shared form is Host-backed, so changes also reach independent Session windows. */
export function installFeatures(ctx: Context, form: ConfigForm<Preferences>): void {
  const sessionWindowSupport = getSessionWindowSupport(ctx)
  const current = (): Preferences => ({ ...DEFAULT_PREFERENCES, ...form.getSnapshot().value })
  ctx.effect(() => {
    const board = new FeatureSwitchboard(field => {
      const fiber = ctx.plugin({
        name: `qiuya-tools/${field}`,
        inject: dependencies[field],
        apply(scope: Context) {
          if (field === 'pastedTextEnabled') scope.effect(() => installPastedText({
            ctx: scope,
            readThresholds: () => ({ characters: current().pasteCharacterThreshold, lines: current().pasteLineThreshold }),
            readFileNamePrefix: () => ctx.locale.getSnapshot().active.startsWith('zh') ? '粘贴文本' : 'Pasted text',
          }))
          else if (field === 'sessionWindowsEnabled') scope.effect(() => installSessionWindows(scope))
          else if (field === 'bulkArchiveEnabled') scope.effect(() => installBulkArchive(scope))
          else if (field === 'planCommentsEnabled') scope.effect(() => installPlanComments(scope))
          else if (field === 'conversationCommentsEnabled') scope.effect(() => installConversationComments(scope))
          else if (field === 'sidebarToolsEnabled') scope.effect(() => installSidebarTools(scope))
          else if (field === 'promptSuggestionsEnabled') scope.effect(() => installPromptSuggestions(scope))
        },
      })
      return () => fiber.dispose()
    })
    const sync = (): void => {
      const snapshot = form.getSnapshot()
      void board.update(snapshot.status === 'ready' ? effectiveSessionWindowPreferences(current(), sessionWindowSupport.getSnapshot()) : undefined)
        .catch(error => { ctx.logger.error('QiuYaTools feature update failed: %s', error) })
    }
    const stop = form.subscribe(sync)
    const stopSupport = sessionWindowSupport.subscribe(sync)
    sync()
    return async () => { stop(); stopSupport(); await board.dispose() }
  })
}
