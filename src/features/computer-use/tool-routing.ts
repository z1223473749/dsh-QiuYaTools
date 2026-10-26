import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComputerEnvironmentManager } from './environment-manager.ts'
import type { RootAgentRegistry } from '../acceptance-runs/sdk-host-seams.ts'

interface RoutingAgent { readonly id: string }
interface PromptContext { agent?: RoutingAgent; scope?: object }
interface RoutingExecution { readonly name: string; readonly arguments: unknown; readonly agent?: RoutingAgent }
export interface ComputerRoutingServices {
  systemPrompt: {
    section(section: { name: string; order: number; interpolate: false; text(context: PromptContext): string }): () => void
    context(context: { name: string; order: number; required: true; interpolate: false; text(context: PromptContext): string }): () => void
  }
  tools: { guard(check: (exec: RoutingExecution) => string | undefined): () => void }
}

const rules = `Computer environment routing:
Follow the current qiuya-tools:computer-environment context for this chat. The environment selector is a tool-routing choice, not merely a display label, and selecting an environment does not grant application access.
When mode is local (这台电脑), use qiuya_computer_* first for tasks involving existing applications, including reading the user's current browser tabs. Start with qiuya_computer_discover (kind: browser for browsers), then qiuya_computer_request_control, then qiuya_computer_observe and qiuya_computer_act as needed. If a session already exists, inspect qiuya_computer_status and observe the authorized target. Wait for owner authorization and honor pause/takeover and system permission errors.
In local mode, do not load browser-skill, call bsk_* or the bsk CLI, execute AppleScript/osascript/JXA, probe browser debugging ports, or use another browser process as a fallback for this application task. Generic BrowserSkill browser instructions do not override the selected computer environment. qiuya_browser_* lists/operates a separate isolated browser, and js-reverse's browser is also separate; neither reports the user's existing browser tabs. An empty dedicated-browser tab list does not mean the user's browser has no tabs.
Use the selected computer tools to report actual connection or permission failures; do not silently switch backends, install browser tooling, read browser profile/session files, or retry unconfirmed input. If the environment is switching or retiring, wait for it to finish.
When mode is browser or remote, use that configured environment and its authorization flow; do not apply local-only routing restrictions. An explicit request for an isolated browser can use qiuya_browser_*; do not substitute it for the user's existing browser.
Normal coding, file processing, builds and tests may still use terminal tools. This routing policy does not require computer tools for those tasks. Additional computer tasks require their explicit taskId; the default task never means the last UI-selected task.`

const denial = '[COMPUTER_ROUTE_REQUIRED] 当前操作环境为“这台电脑”。请使用 qiuya_computer_discover → qiuya_computer_request_control → qiuya_computer_observe/act；不要改走 BrowserSkill、bsk 或 AppleScript。普通代码和文件任务仍可使用终端。'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
// Read command heads without mistaking search terms, quoted source or heredoc
// bodies for executables. This deliberately handles explicit shell entry points;
// it is route correction, not an interpreter or a shell security boundary.
function alternateCommand(command: string): boolean {
  let word = '', quote = '', head = true, delimiter = false
  const heredocs: string[] = []
  const flush = () => {
    if (!word) return false
    const value = word; word = ''
    if (delimiter) { heredocs.push(value); delimiter = false; return false }
    if (!head) return false
    if (/^[\w]+=/u.test(value) || value.startsWith('-')) return false
    if (['command', 'exec', 'sudo', 'env', 'which', 'where', 'then', 'do'].includes(value)) return false
    head = false
    return /(?:^|[/\\])(?:bsk(?:\.exe)?|osascript(?:\.exe)?)$/iu.test(value)
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && quote !== "'" && ['"', '\\'].includes(command[i + 1])) word += command[++i]
      else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '\\' && /[\s"';&|()]/u.test(command[i + 1] ?? '')) { word += command[++i]; continue }
    if (char === '#' && !word) { const end = command.indexOf('\n', i); if (end < 0) break; i = end - 1; continue }
    if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      if (flush()) return true
      delimiter = true; i += command[i + 2] === '-' ? 2 : 1; continue
    }
    if (/\s/u.test(char) || /[;&|()`]/u.test(char)) {
      if (flush()) return true
      if (char === '\n' && heredocs.length) {
        for (const end of heredocs.splice(0)) {
          while (i < command.length) {
            const start = i + 1, next = command.indexOf('\n', start), stop = next < 0 ? command.length : next
            i = stop
            if (command.slice(start, stop).replace(/^\t+/u, '') === end) break
          }
        }
      }
      if (char === '\n' || /[;&|()`]/u.test(char)) head = true
    } else word += char
  }
  return flush()
}

function isAlternateAutomation(exec: RoutingExecution): boolean {
  if (/^bsk(?:_|$)/u.test(exec.name)) return true
  const args = record(exec.arguments)
  if (exec.name === 'skill') return args?.name === 'browser-skill'
  if (!['bash', 'pwsh', 'powershell'].includes(exec.name)) return false
  const command = args?.command
  return typeof command === 'string' && alternateCommand(command)
}

/** Read the same existing per-chat environment metadata as the Composer.
 * Prompt assembly never creates a driver, captures a screen or grants access.
 * The guard re-reads it at dispatch, including for lazy/scoped/PTC tools. */
export function installComputerToolRouting(ctx: Context, environments: Pick<ComputerEnvironmentManager, 'environments'>, enabled: () => boolean): () => void {
  const services = ctx as Context & ComputerRoutingServices
  const agents = ctx.get('agents') as RootAgentRegistry | undefined
  let disposed = false
  const current = (agent: RoutingAgent | undefined) => !disposed && enabled() && !!agent && agents?.get(SessionId(agent.id)) === agent && agents.roots().includes(agent)
  const environment = (agent: RoutingAgent) => environments.environments().find(row => row.sessionId === agent.id)
  const promptAgent = (context: PromptContext) => current(context.agent) && (context.scope === undefined || context.scope === context.agent) ? context.agent : undefined
  const disposers: Array<() => void> = []
  try {
    disposers.push(services.systemPrompt.section({ name: 'qiuya-tools:computer-routing', order: 3010, interpolate: false, text: context => promptAgent(context) ? rules : '' }))
    disposers.push(services.systemPrompt.context({ name: 'qiuya-tools:computer-environment', order: 220, required: true, interpolate: false, text: context => {
      const agent = promptAgent(context)
      if (!agent) return ''
      const selected = environment(agent), mode = selected?.mode ?? 'local'
      return `Current computer environment for this chat's default task: mode=${mode} (${({ local: '这台电脑', browser: '独立浏览器', remote: '远端电脑' })[mode]}). State=${selected?.switching ? 'switching' : selected?.retiring ? 'retiring' : 'selected'}. This selection is not an application authorization. Additional taskId environments are independent.`
    } }))
    disposers.push(services.tools.guard(exec => {
      if (!current(exec.agent)) return
      const selected = environment(exec.agent!)
      if ((selected?.mode ?? 'local') === 'local' && isAlternateAutomation(exec)) return denial
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { if (disposed) return; disposed = true; for (const dispose of disposers.reverse()) dispose() }
}
