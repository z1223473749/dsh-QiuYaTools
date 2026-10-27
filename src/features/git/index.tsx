import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Preferences } from '../../shared.ts'
import { installGitClient } from './client.tsx'
import { createGitWorktreeNavigation } from './worktree-client.ts'
import { installGitWorktreeIndicators } from './worktree-indicator.ts'

/** Keep Git's UI and navigation lifetimes inside its isolated feature fiber. */
export function installGit(ctx: Context, form: ConfigForm<Preferences>): () => void {
  const navigation = createGitWorktreeNavigation(ctx)
  let indicators: ReturnType<typeof installGitWorktreeIndicators> | undefined
  try {
    const worktrees = indicators = installGitWorktreeIndicators({
      sessions: ctx.sessions.list,
      enabled: () => { const value = form.getSnapshot(); return value.status === 'ready' && value.value?.enabled !== false && value.value?.gitEnabled !== false },
      label: pending => ctx.locale.getSnapshot().active.startsWith('zh') ? pending ? '已启用新建工作树' : '工作树会话' : pending ? 'New worktree enabled' : 'Worktree session',
      subscribe: listener => { const off = [form.subscribe(listener), ctx.locale.subscribe(listener)]; return () => { for (const dispose of off) dispose() } },
    })
    const dispose = installGitClient(ctx, form, {
      worktreeAvailable: navigation.available,
      preflightWorktree: id => navigation.preflight(id),
      openWorktree: (id, receipt, ownership) => navigation.openWorktree(id, receipt, ownership),
      worktreeModeChanged: worktrees.setPending,
    })
    return () => { dispose(); worktrees.dispose(); navigation.dispose() }
  } catch (error) { indicators?.dispose(); navigation.dispose(); throw error }
}
