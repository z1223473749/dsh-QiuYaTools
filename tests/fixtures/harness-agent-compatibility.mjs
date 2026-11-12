import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(process.argv[2])
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { AgentRegistry } = await load('@deepseek-ai/dsh-agent')
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const nativeExecutor = await load('@deepseek-ai/dsh-tool-executor-native')
const { installComputerToolRouting, isLiveRootAgent } = await import(pathToFileURL(process.argv[3]).href)
const ctx = new Context(), plugins = []
async function mount(plugin, config) { const fiber = ctx.plugin(plugin, config); plugins.push(fiber); await fiber.await(); return fiber }
try {
  await mount(SessionProjectionRegistry)
  await mount(AgentRegistry)
  await mount(SystemPrompt, { includeHarnessIdentity: false })
  await mount(ToolRuntime)
  await mount(nativeExecutor)
  const agents = ctx.get('agents'), prompt = ctx.get('systemPrompt')
  assert.equal(typeof agents.roots, 'undefined', 'This regression exercises the flat 0.2.2 registry')
  const agent = { id: 'qiuya-compat-main', session: { id: 'qiuya-compat-main', header: { id: 'qiuya-compat-main', parentSession: 'fork-source' } }, ctx }
  const child = { id: 'qiuya-compat-child', session: { id: 'qiuya-compat-child', header: { id: 'qiuya-compat-child', origin: 'subagent' } }, ctx }
  const detach = agents.enter(agent), detachChild = agents.enter(child)
  assert(isLiveRootAgent(agents, agent))
  assert.equal(isLiveRootAgent(agents, child), false)
  let remove, active, injection
  await mount(scope => { injection = scope.inject(['agents', 'systemPrompt', 'tools'], current => {
    active = current; remove = installComputerToolRouting(current, { environments: () => [] }, () => true)
  }) })
  await injection.await()
  const assembly = await prompt.assemble({ agent, scope: agent })
  assert(assembly.sections.some(section => section.name === 'qiuya-tools:computer-routing' && section.text.includes('qiuya_computer_discover')))
  const delegated = await prompt.assemble({ agent: child, scope: child })
  assert(!delegated.sections.some(section => section.name === 'qiuya-tools:computer-routing' && section.text))
  let calls = 0
  const unregister = active.tools.register({
    name: 'bash', description: 'Inert compatibility fixture', parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { calls++; return { executed: true } },
  })
  const run = async command => (await ctx.get('tools').execute({
    calls: [{ type: 'tool-call', id: crypto.randomUUID(), name: 'bash', arguments: JSON.stringify({ command }) }],
    agent, signal: new AbortController().signal,
  })).results[0].result
  assert.equal((await run('git status --short')).isError, false)
  assert.equal((await run('bsk tabs')).isError, true)
  assert.equal(calls, 1)
  remove(); unregister(); detachChild(); detach()
  assert.equal(isLiveRootAgent(agents, agent), false)
  console.log(JSON.stringify({ host: require('@deepseek-ai/dsh-agent/package.json').version, flatRegistry: true, promptAssembly: true, toolGuard: true, childExcluded: true, staleExcluded: true }))
} finally { for (const plugin of plugins.reverse()) await plugin.dispose() }
