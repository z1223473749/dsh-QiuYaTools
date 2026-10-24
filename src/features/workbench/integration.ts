import { BrowserDiagnosticsService } from '../browser-diagnostics/service.ts'
import { installBrowserDiagnosticTools } from '../browser-diagnostics/tools.ts'
import { installBrowserDiagnosticHost } from '../browser-diagnostics/host.ts'
import type { DiagnosticAssociation } from '../browser-diagnostics/contract.ts'
import type { ComputerToolRunContext } from '../computer-use/tools.ts'
import type { HostWorkbenchContext } from './browser-registry.ts'
import { hostServiceIdentity } from '../../host-service-identity.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ComputerEnvironmentManager } from '../computer-use/environment-manager.ts'
import type { ComputerToolsRecorder } from '../computer-use/tools.ts'
import type { RootAgentRegistry, RunProfile, RunSessionQuery } from '../acceptance-runs/sdk-host-seams.ts'
import { ComputerError } from '../computer-use/contract.ts'
import { BrowserPermissionCoordinator } from './site-permissions.ts'
import { BrowserWorkbenchRegistry } from './browser-registry.ts'
import { DesktopWorkbenchRegistry } from './desktop-registry.ts'
import { WorkbenchRegistry } from './registry.ts'
import { ModelTargetRegistry } from './model-target.ts'
import { siteOrigin } from './contract.ts'
import { installBrowserWorkbenchTools } from './tools.ts'
import { installWorkbenchHost, type WorkbenchOwnerScope } from './host.ts'
interface ApprovalPolicy { overrideOf?(session: unknown): string | undefined; config?: { policy?: string } }
interface Connection { browserPeer?: { principal: { kind: string } } }
/** Public Host services, real root Agents, and existing desktop manager; no credentials or model config changes. */
export async function installWorkbench(ctx: Context, desktopManager: ComputerEnvironmentManager, options: { enabled(): boolean; recorder(): ComputerToolsRecorder | undefined; diagnostics?: boolean; diagnosticAssociation?(exec: ComputerToolRunContext, context: HostWorkbenchContext): DiagnosticAssociation | undefined }) {
  const profile = ctx.get('profileContext') as RunProfile | undefined, agents = ctx.get('agents') as RootAgentRegistry | undefined, query = ctx.get('sessionQuery') as RunSessionQuery | undefined, connection = ctx.get('connection') as Connection | undefined
  const connectionIdentity = hostServiceIdentity(connection)
  if (!profile?.dir || !agents || !query || !connection || !connectionIdentity) throw new ComputerError('WORKBENCH_UNAVAILABLE', '工作台所需的宿主服务尚未就绪。')
  const directory = join(profile.dir, 'qiuya-workbench'), permissionPath = join(directory, 'origins.json'), lifetime = new AbortController()
  let allowed: string[] = [], disposed = false, permissions: BrowserPermissionCoordinator
  try { const stored: unknown = JSON.parse(await readFile(permissionPath, 'utf8')); if (!Array.isArray(stored) || stored.length > 128) throw Error('Invalid store'); allowed = stored.map(siteOrigin) } catch { /* Missing or invalid data grants nothing. */ }
  const isCurrentAgent = (agent: { id: string }) => !disposed && !lifetime.signal.aborted && options.enabled() && agents.get(SessionId(agent.id)) === agent && agents.roots().includes(agent)
  const browsers = new BrowserWorkbenchRegistry({ directory, enabled: () => !disposed && options.enabled(), isAllowed: (...args) => permissions.isAllowed(...args), isCallerCurrent: exec => !!exec.agent && !exec.signal.aborted && isCurrentAgent(exec.agent) })
  permissions = new BrowserPermissionCoordinator({ backend: browsers, enabled: () => !disposed && options.enabled(), lookupAgent: id => agents.get(SessionId(id)), isRootAgent: agent => isCurrentAgent(agent), canRequest: agent => { let approval: ApprovalPolicy | undefined; try { approval = ctx.get('approval') as ApprovalPolicy | undefined } catch {}; return ((agent.session ? approval?.overrideOf?.(agent.session) : undefined) ?? approval?.config?.policy) !== 'never' }, readAllowedOrigins: () => allowed, async writeAllowedOrigins(origins) { await mkdir(directory, { recursive: true, mode: 0o700 }); const temporary = join(directory, '.origins-' + randomUUID() + '.json'); await writeFile(temporary, JSON.stringify(origins), { flag: 'wx', mode: 0o600 }); await rename(temporary, permissionPath); allowed = [...origins] } })
  const registry = new WorkbenchRegistry(browsers, new DesktopWorkbenchRegistry(desktopManager)), modelTarget = new ModelTargetRegistry(desktopManager, browsers, isCurrentAgent)
  const resolveScope = async (chatSessionId: string, signal: AbortSignal): Promise<WorkbenchOwnerScope> => {
    const peer = connection.browserPeer, principal = peer?.principal, child = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(2000)])
    const assertCurrent = () => { child.throwIfAborted(); if (disposed || !options.enabled() || hostServiceIdentity(ctx.get('connection')) !== connectionIdentity || connection.browserPeer !== peer || peer?.principal !== principal || principal?.kind !== 'owner') throw new ComputerError('OWNER_CHANGED', '工作台连接已变化。') }
    assertCurrent()
    let abort = () => {}
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new ComputerError('OWNER_CHANGED', '读取当前聊天已取消。')); child.addEventListener('abort', abort, { once: true }) })
    try {
      const observation = await Promise.race([query.observeSession(SessionId(chatSessionId), { signal: child, projectionMode: 'none' }).then(value => { if (child.aborted) { value[Symbol.dispose](); throw new ComputerError('OWNER_CHANGED', '读取当前聊天已取消。') } return value }), cancelled])
      try { assertCurrent(); if (observation.header.id !== chatSessionId) throw new ComputerError('VIEW_CHANGED', '当前聊天已变化。') } finally { observation[Symbol.dispose]() }
    } finally { child.removeEventListener('abort', abort) }
    assertCurrent()
    // The 2s query budget is not the scope lifetime of an already authenticated frame/owner action.
    return { chatSessionId, signal, assertCurrent() { signal.throwIfAborted(); if (disposed || lifetime.signal.aborted || !options.enabled() || hostServiceIdentity(ctx.get('connection')) !== connectionIdentity || connection.browserPeer !== peer || peer?.principal !== principal || principal?.kind !== 'owner') throw new ComputerError('OWNER_CHANGED', '工作台连接已变化。') } }
  }
  const diagnostics = new BrowserDiagnosticsService({ registry: browsers, enabled: () => !disposed && options.enabled(), current: isCurrentAgent, canRequest(agent) { let approval: ApprovalPolicy | undefined; try { approval = ctx.get('approval') as ApprovalPolicy | undefined } catch {}; return ((agent.session ? approval?.overrideOf?.(agent.session) : undefined) ?? approval?.config?.policy) !== 'never' }, selected(exec, context) { modelTarget.assertBrowser(exec, context) }, association: options.diagnosticAssociation })
  let removeDiagnosticTools: (() => void) | undefined, removeDiagnosticHost: (() => Promise<void>) | undefined
  let unregisterHost: (() => Promise<void>) | undefined, unregisterTools: (() => void) | undefined
  try { if (options.diagnostics) { removeDiagnosticHost = installBrowserDiagnosticHost(ctx, diagnostics, resolveScope); removeDiagnosticTools = installBrowserDiagnosticTools(ctx, diagnostics) } unregisterHost = installWorkbenchHost(ctx, { registry, permissions, resolveScope }); unregisterTools = installBrowserWorkbenchTools(ctx, browsers, permissions, { onSelected: (exec, context) => modelTarget.selectBrowser(exec, context), recorder: {
    async observed(exec, context, observation, image, at) { context.assertCurrent(); modelTarget.assertBrowser(exec, context); const value = await options.recorder()?.observed(exec, observation, image, at); context.assertCurrent(); modelTarget.assertBrowser(exec, context); return value },
    async issuing(exec, context, request) {
      context.assertCurrent(); modelTarget.assertBrowser(exec, context)
      const complete = await options.recorder()?.issuing(exec, request)
      try { context.assertCurrent(); modelTarget.assertBrowser(exec, context) } catch (failure) { try { await complete?.(undefined) } catch {} throw failure }
      if (!complete) return undefined
      let consumed = false
      return async result => {
        if (consumed) throw new ComputerError('ACTION_REPLAY_FORBIDDEN', '验收回执不能重复提交。')
        consumed = true; let started = false
        try { if (result) { browsers.assertAfter(context); modelTarget.assertBrowser(exec, context) } started = true; const value = await complete(result); browsers.assertAfter(context); modelTarget.assertBrowser(exec, context); return value }
        catch (failure) { if (!started) try { await complete(undefined) } catch {} throw failure }
      }
    },
  } }) } catch (failure) {
    disposed = true; lifetime.abort()
    const failures: unknown[] = [failure]
    for (const work of [() => removeDiagnosticTools?.(), () => removeDiagnosticHost?.(), () => diagnostics.dispose(), () => unregisterHost?.(), () => permissions.dispose(), () => browsers.dispose()]) try { await work() } catch (cleanupFailure) { failures.push(cleanupFailure) }
    throw new AggregateError(failures, '电脑工作台初始化未完成。')
  }
  let wasEnabled = options.enabled(), stopping: Promise<void> | undefined
  const poll = setInterval(() => { const enabled = options.enabled(); if (!enabled && wasEnabled && !stopping) { modelTarget.clear(); permissions.sweep(); stopping = browsers.stopAll(); void stopping.catch(() => ctx.logger.error('浏览器输入清理未能确认，请在电脑操控设置中检查当前任务。')).finally(() => { stopping = undefined }) } wasEnabled = enabled }, 100)
  poll.unref()
  return { modelTarget, browsers, permissions, registry, diagnostics, resolveOwnerScope: resolveScope, async dispose() { if (disposed) return; disposed = true; lifetime.abort(); clearInterval(poll); modelTarget.clear(); const failures: unknown[] = []; for (const work of [() => removeDiagnosticTools?.(), () => removeDiagnosticHost?.(), () => diagnostics.dispose(), () => unregisterTools?.(), () => unregisterHost?.(), () => permissions.dispose(), () => stopping, () => browsers.dispose()]) { try { await work() } catch (failure) { failures.push(failure) } } if (failures.length) throw new AggregateError(failures, '工作台清理尚未确认。') } }
}
