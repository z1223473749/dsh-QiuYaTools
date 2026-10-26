import type { Context } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Preferences } from '../../shared.ts'
import { installGitClient } from './client.tsx'
import { createGitWorktreeNavigation } from './worktree-client.ts'

/** Keep Git's UI and navigation lifetimes inside its isolated feature fiber. */
export function installGit(ctx: Context, form: ConfigForm<Preferences>): () => void {
  const navigation = createGitWorktreeNavigation(ctx)
  try {
    const dispose = installGitClient(ctx, form, {
      worktreeAvailable: navigation.available,
      preflightWorktree: id => navigation.preflight(id),
      openWorktree: (id, receipt, ownership) => navigation.openWorktree(id, receipt, ownership),
    })
    return () => { dispose(); navigation.dispose() }
  } catch (error) { navigation.dispose(); throw error }
}
