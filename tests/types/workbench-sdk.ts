import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { parseWorkbenchAddress } from '../../src/features/workbench/contract.ts'
export const definition = { id: 'qiuya-tools.workbench', kind: 'qiuya-workbench', multiple: true, keepMounted: false, patterns: ['dsh-resource://qiuya-workbench/**'], canOpen: (address: string) => parseWorkbenchAddress(address) !== null, title: () => '电脑工作台' } satisfies SidebarRightTabDefinition
export function occurrence(props: PropsRuntime<'sidebar.right.pane.tab'>): () => void {
  const info = props.useTabInfo()
  const signal: AbortSignal = info.tab.signal
  signal.throwIfAborted()
  return info.tab.actions.bindCommands({ refresh: () => info.tab.actions.openResource(info.tab.navigation.address, { replaceTab: true }) })
}
