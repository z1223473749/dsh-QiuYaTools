import type { Context } from '@deepseek-ai/cordis'
import type { WorkbenchRegistry } from '../../src/features/workbench/registry.ts'
import type { BrowserPermissionCoordinator } from '../../src/features/workbench/site-permissions.ts'
import { installWorkbenchHost } from '../../src/features/workbench/host.ts'
import type { WorkbenchHostOptions } from '../../src/features/workbench/host.ts'
declare const context: Context
declare const registry: WorkbenchRegistry
declare const permissions: BrowserPermissionCoordinator
declare const resolveScope: WorkbenchHostOptions['resolveScope']
installWorkbenchHost(context, { registry, permissions, resolveScope })
