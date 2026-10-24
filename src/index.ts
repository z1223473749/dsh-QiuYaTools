import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { installSessionWindowsHost } from './features/session-windows/host.ts'
import { installPluginUpdatesHost } from './updates/host.ts'
import { installPromptSuggestionsHost } from './features/prompt-suggestions/host.ts'
import { PROJECT_REPOSITORY } from './project.ts'
import { installComputerHost } from './features/computer-use/host.ts'
import { installComputerTools, type ComputerToolsRecorder } from './features/computer-use/tools.ts'
import { installComputerAcceptanceRuns } from './features/acceptance-runs/integration.ts'
import { installAcceptanceWorkflows } from './features/acceptance-workflows/integration.ts'
import { WorkflowEvidenceVerifier } from './features/acceptance-workflows/verifier.ts'
import { installAnnotations } from './features/annotations/integration.ts'
import { createWorkbenchAnnotationSource } from './features/workbench/annotation-source.ts'
import { installWorkbench } from './features/workbench/integration.ts'
import type { ModelTargetRegistry } from './features/workbench/model-target.ts'
import pkg from '../package.json' with { type: 'json' }

/** Preferences persisted by Harness in the active profile. */
export interface Config {
  enabled: Volatile<boolean>
  pastedTextEnabled: Volatile<boolean>
  sessionWindowsEnabled: Volatile<boolean>
  bulkArchiveEnabled: Volatile<boolean>
  planCommentsEnabled: Volatile<boolean>
  sidebarToolsEnabled: Volatile<boolean>
  promptSuggestionsEnabled: Volatile<boolean>
  qThemeEnabled: Volatile<boolean>
  computerUseEnabled: Volatile<boolean>
  pasteCharacterThreshold: Volatile<number>
  pasteLineThreshold: Volatile<number>
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('启用工具箱功能').volatile(),
  pastedTextEnabled: z.boolean().default(true).description('将长文本粘贴为 TXT 附件').volatile(),
  sessionWindowsEnabled: z.boolean().default(true).description('在独立窗口中打开会话').volatile(),
  bulkArchiveEnabled: z.boolean().default(true).description('多选会话并批量归档，或归档工作区内的全部会话').volatile(),
  planCommentsEnabled: z.boolean().default(true).description('为计划添加批注并提交修改建议').volatile(),
  sidebarToolsEnabled: z.boolean().default(true).description('扩展会话与工作区菜单：未读、复制、打开目录').volatile(),
  promptSuggestionsEnabled: z.boolean().default(true).description('根据当前会话推荐下一句提示词，按 Tab 填入但不自动发送').volatile(),
  qThemeEnabled: z.boolean().default(false).description('为整个 Harness 启用青蓝海面 Q 主题').volatile(),
  computerUseEnabled: z.boolean().default(false).description('启用电脑操控、实时悬浮预览和人工接管').volatile(),
  pasteCharacterThreshold: z.number().step(1).min(1).max(1_000_000).default(1000)
    .description('粘贴内容达到此字符数时转为 TXT 附件').volatile(),
  pasteLineThreshold: z.number().step(1).min(1).max(100_000).default(15)
    .description('粘贴内容达到此行数时转为 TXT 附件').volatile(),
})

/** QiuYaTools owns its settings page instead of a second generated form. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['connection', 'webServer'], child => {
    let stopped = false
    let cleanup: (() => Promise<void>) | undefined
    child.effect(() => {
      void installComputerHost(child, () => config.enabled.get() && config.computerUseEnabled.get()).then(host => {
        if (stopped) return host.dispose()
        cleanup = host.dispose
        child.inject(['tools', 'attachments'], tools => {
          tools.effect(() => {
            const enabled = () => config.enabled.get() && config.computerUseEnabled.get()
            let recorder: ComputerToolsRecorder | undefined, modelTarget: ModelTargetRegistry | undefined
            const unregister = installComputerTools(tools, host.service, { enabled, entry: host.entry, onSelected: exec => modelTarget?.selectDesktop(exec), recorder: {
              observed: (...args) => recorder?.observed(...args) ?? Promise.resolve(undefined),
              issuing: (...args) => recorder?.issuing(...args) ?? Promise.resolve(undefined),
            } })
            const integration = tools.inject(['agents', 'sessionQuery', 'profileContext'], runsContext => {
              runsContext.effect(() => {
                if (!host.manager) return () => {}
                const nativeManager = host.manager, runEnvironments = { runEnvironment(id: string) { return modelTarget ? modelTarget.runEnvironment(id) : nativeManager.runEnvironment(id) } }
                const workflowVerifier = new WorkflowEvidenceVerifier()
                const runs = installComputerAcceptanceRuns(runsContext, runEnvironments, { enabled, version: pkg.version, verifiers: [workflowVerifier.verifier], onEvidenceCommitted: (exec, evidence, observation) => workflowVerifier.capture(exec, evidence, observation) })
                recorder = runs.computer
                let stopped = false, annotations: Awaited<ReturnType<typeof installAnnotations>> | undefined, workbench: Awaited<ReturnType<typeof installWorkbench>> | undefined, workflows: Awaited<ReturnType<typeof installAcceptanceWorkflows>> | undefined
                const preparing = installWorkbench(runsContext, nativeManager, { enabled, recorder: () => recorder }).then(async value => { if (stopped) { await value.dispose(); return } workbench = value; modelTarget = value.modelTarget; const annotationSource = createWorkbenchAnnotationSource({ registry: value.registry, browsers: value.browsers, enabled }); const annotation = await installAnnotations(runsContext, { source: annotationSource, resolveOwnerScope: value.resolveOwnerScope, enabled }); if (stopped) { await annotation.dispose(); return } annotations = annotation; const prepared = await installAcceptanceWorkflows(runsContext, { enabled, target: value.modelTarget, verifier: workflowVerifier, ledger: runs.ledger }); if (stopped) { await prepared.dispose(); return } workflows = prepared }).catch(() => runsContext.logger.error('电脑工作台初始化失败，请检查当前宿主版本与插件连接。'))
                return async () => {
                  stopped = true; if (recorder === runs.computer) recorder = undefined
                  if (modelTarget === workbench?.modelTarget) modelTarget = undefined
                  await preparing
                  const workflowResults = await Promise.allSettled([annotations?.dispose(), workflows?.dispose()]); workflowVerifier.dispose()
                  const results = [...workflowResults, ...await Promise.allSettled([runs.dispose(), workbench?.dispose()])], failed = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
                  if (failed.length) throw new AggregateError(failed.map(value => value.reason), '工作台清理尚未确认。')
                }
              })
            })
            return async () => { recorder = undefined; unregister(); await integration.dispose() }
          })
        })
      }).catch(error => child.logger.error('电脑操控初始化失败：%s', error instanceof Error ? error.message : '初始化失败'))
      return async () => { stopped = true; await cleanup?.() }
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
  ctx.inject(['connection', 'llm', 'sessions', 'sessionProjections', 'agentDefaultModel'], child => {
    child.effect(() => installPromptSuggestionsHost(child, () => config.enabled.get() && config.promptSuggestionsEnabled.get()))
  })
}
