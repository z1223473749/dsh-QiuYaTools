import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { installSessionWindowsHost } from './features/session-windows/host.ts'
import { installPluginUpdatesHost } from './updates/host.ts'
import { PROJECT_REPOSITORY } from './project.ts'
import pkg from '../package.json' with { type: 'json' }

/** Preferences persisted by Harness in the active profile. */
export interface Config {
  enabled: Volatile<boolean>
  pastedTextEnabled: Volatile<boolean>
  sessionWindowsEnabled: Volatile<boolean>
  bulkArchiveEnabled: Volatile<boolean>
  planCommentsEnabled: Volatile<boolean>
  pasteCharacterThreshold: Volatile<number>
  pasteLineThreshold: Volatile<number>
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用工具箱功能').volatile(),
  pastedTextEnabled: z.boolean().default(true).description('将长文本粘贴为 TXT 附件').volatile(),
  sessionWindowsEnabled: z.boolean().default(true).description('在独立窗口中打开会话').volatile(),
  bulkArchiveEnabled: z.boolean().default(true).description('多选会话并批量归档，或归档工作区内的全部会话').volatile(),
  planCommentsEnabled: z.boolean().default(true).description('为计划添加批注并提交修改建议').volatile(),
  pasteCharacterThreshold: z.number().step(1).min(1).max(1_000_000).default(1000)
    .description('粘贴内容达到此字符数时转为 TXT 附件').volatile(),
  pasteLineThreshold: z.number().step(1).min(1).max(100_000).default(15)
    .description('粘贴内容达到此行数时转为 TXT 附件').volatile(),
})

/** QiuYaTools owns its settings page instead of a second generated form. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['connection'], child => {
    child.effect(() => installPluginUpdatesHost(child, { repository: PROJECT_REPOSITORY, version: pkg.version, packageName: pkg.name }))
  })
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.inject(['connection', 'webServer'], child => {
    child.effect(() => installSessionWindowsHost(child, () => config.enabled.get() && config.sessionWindowsEnabled.get()))
  })
}
