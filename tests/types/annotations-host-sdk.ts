/** Compile only against actual public SDK services; no Host or browser is started. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { installAnnotationHost, type AnnotationHostOptions } from '../../src/features/annotations/host.ts'
import { installAnnotations } from '../../src/features/annotations/integration.ts'
import { WorkbenchAnnotationSource } from '../../src/features/workbench/annotation-source.ts'
import type { WorkbenchRegistry } from '../../src/features/workbench/registry.ts'
import type { BrowserWorkbenchRegistry } from '../../src/features/workbench/browser-registry.ts'
declare const ctx: Context
declare const registry: WorkbenchRegistry
declare const browsers: BrowserWorkbenchRegistry
declare const resolveScope: AnnotationHostOptions['resolveScope']
declare const connection: HostConnectionHandle
const source = new WorkbenchAnnotationSource({ registry, browsers, enabled: () => true })
installAnnotationHost(ctx, { source, resolveScope })
installAnnotations(ctx, { source, resolveOwnerScope: resolveScope, enabled: () => true })
const peer = connection.browserPeer
void peer
