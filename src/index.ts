import { installThemeArtHost } from './features/theme-art-host.ts'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { installSessionWindowsHost } from './features/session-windows/host.ts'
import { installPluginUpdatesHost } from './updates/host.ts'
import { installSmartThemeHost } from './features/smart-theme/host.ts'
import { installThemeVideoHost } from './features/theme-video/host.ts'
import { LOCAL_VIDEO_ID } from './theme-video.ts'
import { MOTION_KINDS } from './smart-motion.ts'
import { installPromptSuggestionsHost } from './features/prompt-suggestions/host.ts'
import { PROJECT_REPOSITORY } from './project.ts'
import pkg from '../package.json' with { type: 'json' }
import { installGitHost } from './features/git/host.ts'
import { CUSTOM_THEME_ID, THEME_IMAGE, MAX_CUSTOM_THEMES, MAX_THEME_IMAGE_BYTES, THEME_MOVEMENTS, THEME_ATMOSPHERES, type CustomTheme } from './custom-themes.ts'
import { DEFAULT_Q_THEME_ID, DEFAULT_Q_THEME_SETTINGS, Q_THEME_IDS, type QThemeId, type QThemeSettings } from './shared.ts'

/** Preferences persisted by Harness in the active profile. */
export interface Config {
  enabled: Volatile<boolean>
  pastedTextEnabled: Volatile<boolean>
  sessionWindowsEnabled: Volatile<boolean>
  bulkArchiveEnabled: Volatile<boolean>
  planCommentsEnabled: Volatile<boolean>
  conversationCommentsEnabled: Volatile<boolean>
  sidebarToolsEnabled: Volatile<boolean>
  promptSuggestionsEnabled: Volatile<boolean>
  gitEnabled: Volatile<boolean>
  qThemeEnabled: Volatile<boolean>
  qThemeId: Volatile<QThemeId>
  qThemeSettings: Volatile<QThemeSettings>
  qCustomThemes: Volatile<CustomTheme[]>
  autoCheckUpdates: Volatile<boolean>
  pasteCharacterThreshold: Volatile<number>
  pasteLineThreshold: Volatile<number>
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用工具箱功能').volatile(),
  pastedTextEnabled: z.boolean().default(true).description('附件增强：长文本转 TXT、跨应用文件拖入与内容预览').volatile(),
  sessionWindowsEnabled: z.boolean().default(true).description('在独立窗口中打开会话').volatile(),
  bulkArchiveEnabled: z.boolean().default(true).description('多选会话并批量归档，或归档工作区内的全部会话').volatile(),
  planCommentsEnabled: z.boolean().default(true).description('为计划添加批注并提交修改建议').volatile(),
  conversationCommentsEnabled: z.boolean().default(true).description('为会话回复添加批注并提交修改建议').volatile(),
  sidebarToolsEnabled: z.boolean().default(true).description('扩展会话与工作区菜单：未读、复制、打开目录').volatile(),
  promptSuggestionsEnabled: z.boolean().default(true).description('根据当前会话推荐下一句提示词，按 Tab 填入但不自动发送').volatile(),
  gitEnabled: z.boolean().default(true).description('会话分支、改动统计、Git 对比、提交与 PR').volatile(),
  qThemeEnabled: z.boolean().default(true).description('为整个 Harness 启用 Q 主题').volatile(),
  qThemeId: z.union([...Q_THEME_IDS.map(id => z.const(id)), z.string().pattern(CUSTOM_THEME_ID)]).default(DEFAULT_Q_THEME_ID).description('当前 Q 主题').volatile(),
  qThemeSettings: z.object(Object.fromEntries(Q_THEME_IDS.map(id => [id, z.object({
    motion: z.union([z.const('dynamic'), z.const('static')]).default('dynamic'),
    ...(id === 'fox' ? { muted: z.boolean().default(true) } : {}),
  }).default(DEFAULT_Q_THEME_SETTINGS[id])]))).default(DEFAULT_Q_THEME_SETTINGS).description('各 Q 主题的独立设置').volatile(),
  qCustomThemes: z.array(z.object({
    id: z.string().pattern(CUSTOM_THEME_ID), name: z.string().min(1).max(40),
    image: z.string().pattern(THEME_IMAGE).max(Math.ceil(MAX_THEME_IMAGE_BYTES / 3) * 4 + 40),
    width: z.number().step(1).min(1).max(1600), height: z.number().step(1).min(1).max(1600),
    accent: z.string().pattern(/^#[a-f0-9]{6}$/i),
    motion: z.union([z.const('dynamic'), z.const('static')]),
    movement: z.union(THEME_MOVEMENTS.map(value => z.const(value))),
    atmosphere: z.union(THEME_ATMOSPHERES.map(value => z.const(value))),
    atmosphereColor: z.string().pattern(/^#[a-f0-9]{6}$/i),
    video: z.union([z.never(), z.object({
      assetId: z.string().pattern(LOCAL_VIDEO_ID), sound: z.boolean(),
      sidebar: z.union([z.const('video'), z.const('cover')]),
      x: z.number().min(0).max(100), y: z.number().min(0).max(100),
      zoom: z.union([z.never(), z.number().min(1).max(2)]),
      frame: z.number().min(0),
      coverAccent: z.union([z.never(), z.string().pattern(/^#[a-f0-9]{6}$/i)]),
    })]),
    smartMotion: z.union([z.never(), z.object({
      version: z.const(1), assetId: z.string().pattern(/^[a-f0-9]{64}$/), sourceHash: z.string().pattern(/^[a-f0-9]{64}$/),
      regions: z.array(z.object({
        id: z.string().pattern(/^r[0-7]$/), kind: z.union(MOTION_KINDS.map(v => z.const(v))), label: z.string().min(1).max(32),
        polygon: z.array(z.array(z.number().min(0).max(1)).min(2).max(2)).min(3).max(64),
        segmentation: z.union([z.never(), z.object({
          crop: z.object({ id: z.string().pattern(/^r[0-7]$/), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(.005).max(1), height: z.number().min(.005).max(1) }),
          choice: z.union([z.never(), z.number().min(0).max(23)]),
          positive: z.array(z.array(z.number().min(0).max(1)).min(2).max(2)).max(4),
          negative: z.array(z.array(z.number().min(0).max(1)).min(2).max(2)).max(4),
        })]),
        anchor: z.array(z.number().min(0).max(1)).min(2).max(2), tip: z.array(z.number().min(0).max(1)).min(2).max(2),
        amplitude: z.number().min(0).max(.025), speed: z.number().min(.1).max(3), direction: z.number().min(-180).max(180), enabled: z.boolean(),
      })).max(8),
      protect: z.array(z.array(z.array(z.number().min(0).max(1)).min(2).max(2)).min(3).max(64)).max(16),
      strokes: z.array(z.object({ regionId: z.string().pattern(/^r[0-7]$/), mode: z.union(['paint', 'erase', 'protect'].map(v => z.const(v))), radius: z.number().min(.002).max(.1), points: z.array(z.array(z.number().min(0).max(1)).min(2).max(2)).min(1).max(128) })).max(128),
    })]),
    intensity: z.number().min(0).max(1), speed: z.number().min(.1).max(5),
    x: z.number().min(0).max(100), y: z.number().min(0).max(100),
    zoom: z.number().min(1).max(2), mask: z.number().min(.5).max(1),
  })).max(MAX_CUSTOM_THEMES).default([]).description('用户自定义主题和压缩图片，随当前配置保存').volatile(),
  autoCheckUpdates: z.boolean().default(true).description('后台自动检查插件更新并显示提醒，安装由用户确认').volatile(),
  pasteCharacterThreshold: z.number().step(1).min(1).max(1_000_000).default(1000)
    .description('粘贴内容达到此字符数时转为 TXT 附件').volatile(),
  pasteLineThreshold: z.number().step(1).min(1).max(100_000).default(15)
    .description('粘贴内容达到此行数时转为 TXT 附件').volatile(),
})

/** QiuYaTools owns its settings page instead of a second generated form. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['connection', 'sessionQuery', 'profileContext', 'agents', 'sessions'], child => {
    child.effect(() => {
      const host = installGitHost(child, () => config.enabled.get() && config.gitEnabled.get())
      return () => host.dispose()
    })
  })
  ctx.inject(['connection'], child => {
    child.effect(() => installPluginUpdatesHost(child, { repository: PROJECT_REPOSITORY, version: pkg.version, packageName: pkg.name }))
  })
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.inject(['connection', 'webServer'], child => {
    child.effect(() => installSessionWindowsHost(child, () => config.enabled.get() && config.sessionWindowsEnabled.get()))
  })
  ctx.inject(['connection', 'profileContext'], child => {
    child.effect(() => installThemeArtHost(child))
    child.effect(() => installThemeVideoHost(child, id => config.qCustomThemes.get().some(theme => theme.video?.assetId === id)))
  })
  ctx.inject(['connection', 'llm', 'attachments', 'profileContext'], child => {
    child.effect(() => installSmartThemeHost(child, { isAssetReferenced: assetId => config.qCustomThemes.get().some(theme => theme.smartMotion?.assetId === assetId) }))
  })
  ctx.inject(['connection', 'llm', 'sessions', 'sessionProjections', 'agentDefaultModel'], child => {
    child.effect(() => installPromptSuggestionsHost(child, () => config.enabled.get() && config.promptSuggestionsEnabled.get()))
  })
}
