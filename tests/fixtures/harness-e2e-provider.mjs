/** Local-only deterministic provider for the installed Harness UI E2E runner. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'qiuya-harness-e2e-provider'
export const inject = ['llm']
const provider = 'qiuya-e2e'
const model = 'fixture'
const plan = '# E2E 测试计划\n\n检查真实会话和插件菜单。\n\n验证批注会提交为新的提示，不覆盖原有草稿。'
const metadata = { provider, id: model, name: 'QiuYa 本地测试模型', inputModalities: ['text', 'image'], context: { contextWindow: 128000 }, defaultMaxTokens: 4096, systemPromptUpdate: 'in-history' }
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, milliseconds)
  function done() { signal?.removeEventListener('abort', abort); resolve() }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')) }
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
})
export function apply(ctx) {
  if (process.env.QIUYA_HARNESS_E2E !== '1' || !process.env.DSH_HOME?.includes('qiuya-harness-')) throw new Error('The E2E provider requires a dedicated temporary DSH_HOME')
  const submittedPlans = new Set(), submittedComputers = new Map()
  function *call(name, args) {
    yield { type: 'tool-call-delta', index: 0, id: `fixture-call-${Date.now()}`, name, argumentsDelta: JSON.stringify(args) }
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 50 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const adapter = {
    providerInfo: () => ({ id: provider, name: 'QiuYa 本地测试', nativeAuth: { env: [], oauth: false } }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
    listModels: async () => [metadata],
    resolveModel: async () => metadata,
    prepareCall: async () => ({ model: metadata, stream: options => adapter.stream(options) }),
    async *stream(options) {
      const messages = options.messages ?? []
      const users = messages.filter(message => message.role === 'user')
      const latest = [...users].reverse().find(message => textOf(message).startsWith('E2E:')) ?? users.at(-1)
      const text = textOf(latest)
      const system = [options.system ?? '', ...messages.filter(message => message.role === 'system').map(textOf)].join('\n')
      const images = messages.flatMap((message, messageIndex) => (message.content ?? []).filter(block => block.type === 'image').map(block => ({
        messageIndex, role: message.role, attachmentId: block.attachment?.attachmentId, width: block.attachment?.width,
        height: block.attachment?.height, mediaType: block.attachment?.mediaType,
      })))
      const actionResults = []
      function collectActions(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 4) return
        if (value.actionId === 'fixture-agent-move') actionResults.push({ actionId: value.actionId, targetId: value.targetId, epoch: value.epoch, performed: value.result?.performed === true })
        for (const nested of Object.values(value)) collectActions(nested, depth + 1)
      }
      for (const message of messages.filter(message => message.role === 'tool')) {
        for (const block of message.content ?? []) if (block.type === 'text') { try { collectActions(JSON.parse(block.text)) } catch {} }
      }
      appendFileSync(join(process.env.DSH_HOME, 'e2e-adapter-requests.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        sessionId: options.sessionId ?? null, marker: text.startsWith('E2E:') ? text.slice(0, 80) : 'auxiliary', tools: (options.tools ?? []).map(tool => tool.name),
        imageBlocks: images, actionResults, purpose: options.purpose ?? null }) + '\n', { mode: 0o600 })
      const key = `${options.sessionId}:${text}`
      if (options.maxTokens <= 200 && /natural sentence|next|建议|recommend/i.test(system)) {
        yield { type: 'text-delta', index: 0, text: '继续检查本地测试结果。' }
      } else if (text.startsWith('E2E:computer')) {
        const stage = submittedComputers.get(key) ?? 0
        const tools = options.tools ?? []
        if (stage === 0) {
          if (tools.some(tool => tool.name === 'run_code')) {
            submittedComputers.set(key, 3)
            yield *call('run_code', { code: "const before = await tools.qiuya_computer_observe({}); const action = await tools.qiuya_computer_act({frameId:before.frameId,actionId:'fixture-agent-move',action:{kind:'move',x:Math.floor(before.width/2),y:Math.floor(before.height/2)}}); const after = await tools.qiuya_computer_observe({}); return {action,after};", description: '观察本次授权的测试应用，移动指针，再检查画面' }); return
          }
          if (tools.some(tool => tool.name === 'qiuya_computer_observe')) { submittedComputers.set(key, 1); yield *call('qiuya_computer_observe', {}); return }
          yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_TOOL_UNAVAILABLE' }
        } else if (stage === 1) {
          const observationText = [...messages].reverse().filter(message => message.role === 'tool').map(textOf).join('\n')
          const frameId = observationText.match(/"frameId"\s*:\s*"([^"\\]+)"/u)?.[1]
          const image = images.at(-1)
          if (frameId && image && tools.some(tool => tool.name === 'qiuya_computer_act')) {
            submittedComputers.set(key, 2)
            yield *call('qiuya_computer_act', { frameId, actionId: 'fixture-agent-move', action: { kind: 'move', x: Math.floor(image.width / 2), y: Math.floor(image.height / 2) } }); return
          }
          yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_FRAME_MISSING' }
        } else if (stage === 2) {
          if (!actionResults.some(result => result.performed)) { yield { type: 'text-delta', index: 0, text: 'E2E_COMPUTER_ACTION_FAILED' }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
          submittedComputers.set(key, 3); yield *call('qiuya_computer_observe', {}); return
        } else {
          yield { type: 'text-delta', index: 0, text: images.length ? `E2E_ADAPTER_IMAGE_CONFIRMED:${images.length}` : 'E2E_COMPUTER_IMAGE_MISSING' }
        }
      } else if (text.startsWith('E2E:plan') && !submittedPlans.has(key)) {
        submittedPlans.add(key)
        // Leave the real composer available briefly so the browser can seed a
        // human draft before the official pending-plan surface replaces it.
        await delay(1000, options.signal)
        const tools = options.tools ?? []
        const native = tools.find(tool => tool.name === 'exit_plan_mode')
        const ptc = tools.find(tool => tool.name === 'run_code')
        if (native || ptc) {
          const name = native ? 'exit_plan_mode' : 'run_code'
          const args = native ? { plan } : { code: `return await tools.exit_plan_mode(${JSON.stringify({ plan })})`, description: '提交本地测试计划' }
          yield *call(name, args); return
        }
        yield { type: 'text-delta', index: 0, text: 'E2E_PLAN_TOOL_UNAVAILABLE' }
      } else {
        const answer = text.includes('E2E:slow') ? '本地慢速回复用于验证中断。'.repeat(8) : `已完成本地测试回复：${text.slice(0, 180) || '继续检查测试结果。'}`
        for (let start = 0; start < answer.length; start += 12) {
          if (options.signal?.aborted) throw options.signal.reason
          yield { type: 'text-delta', index: 0, text: answer.slice(start, start + 12) }
          await delay(text.includes('E2E:slow') ? 150 : 10, options.signal)
        }
      }
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter))
}
