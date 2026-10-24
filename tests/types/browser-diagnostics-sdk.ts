import type { ToolRuntime, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { DiagnosticToolServices } from '../../src/features/browser-diagnostics/tools.ts'
import type { BrowserDiagnosticsService } from '../../src/features/browser-diagnostics/service.ts'
import type { RunExec } from '../../src/features/acceptance-runs/service.ts'
import type { RunReadConnection } from '../../src/features/acceptance-runs/client-api.ts'
declare const tools: ToolRuntime
const toolFace: DiagnosticToolServices['tools'] = tools
declare const exec: ToolRunContext
const runExec: RunExec = exec
declare const service: BrowserDiagnosticsService
service.read(exec, 'host-issued-id')
declare const connection: HostConnectionHandle
connection.fetch.register({ path: '/api/qiuya-tools.browser-diagnostics', methods: ['POST'], requestBody: 'buffered', async fetch() { return Response.json({}) } })
void [toolFace, runExec]
