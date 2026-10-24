import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkbenchAPI } from './client-api.ts'
import type { WorkbenchTarget } from './contract.ts'
import { parseWorkbenchAddress } from './contract.ts'
import { RunReadRefreshBus } from '../acceptance-runs/resources.ts'
export { RunReadRefreshBus as WorkbenchRefreshBus }
export interface WorkbenchResource { target: WorkbenchTarget }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface ResourceProtocolMap { 'qiuya-workbench': WorkbenchResource } }
const failure = (): RemoteFailure => Object.assign(new Error('工作台视图暂不可用，请刷新。'), { code: 'gateway/internal' as const, details: {}, isDSHRemoteError: true as const })
/** Resources retain metadata only. Only a visible view asks for frames; hiding/closing never sends device commands. */
export function createWorkbenchResourceProvider(api: WorkbenchAPI, bus: RunReadRefreshBus, current: (chat: string) => boolean): ResourceProvider<'qiuya-workbench'> {
  return { protocol: 'qiuya-workbench', async *open(address, { signal: owner }) {
    const signal = AbortSignal.any([owner, bus.signal]), parsed = parseWorkbenchAddress(address)
    if (!parsed) { yield { ok: false, error: failure() }; return }
    while (!signal.aborted && !bus.closed) {
      const revision = bus.version(address)
      try {
        if (!current(parsed.chatSessionId)) throw Error('Session changed')
        const state = await api.status(parsed.chatSessionId, signal), target = state.views.find(value => value.workbenchTabId === parsed.workbenchTabId)
        if (signal.aborted || bus.closed) return
        if (!current(parsed.chatSessionId) || !target) throw Error('View changed')
        yield { ok: true, value: { target } }
      } catch { if (signal.aborted || bus.closed) return; yield { ok: false, error: failure() } }
      await bus.wait(address, revision, signal)
    }
  } }
}
