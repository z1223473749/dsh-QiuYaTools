import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { projectHarnessComputerToolErrors, captureHarnessComputerDiagnostic, HARNESS_COMPUTER_DIAGNOSTIC_CODES } from './fixtures/harness-e2e-provider.mjs'
import vm from 'node:vm'
const source = (await build({ entryPoints: [fileURLToPath(new URL('../src/features/computer-use/tools.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })).outputFiles[0].text
const { installComputerTools } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
function fixture(error) {
  const tools = new Map(), ctx = { tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } } }
  const entry = { async discover() { throw error }, async requestControl() { throw error } }
  const dispose = installComputerTools(ctx, {}, { entry })
  return { tools, dispose, exec: { agent: { id: 'own' }, callId: 'own-call', signal: new AbortController().signal } }
}

test('entry-only errors retain finite code prefixes through a message-only PTC carrier without echoing exception data', async () => {
  for (const code of ['CALLER_NOT_LIVE', 'DELEGATED_CALLER', 'APPROVAL_DISABLED', 'CANDIDATE_EXPIRED', 'SYSTEM_PERMISSION_REQUIRED', 'APP_DENIED']) {
    const f = fixture(Object.assign(new Error('/Users/private/helper?token=secret'), { code }))
    try {
      for (const name of ['qiuya_computer_discover', 'qiuya_computer_request_control']) {
        const error = await f.tools.get(name).execute(name.endsWith('discover') ? {} : { candidateId: 'one', reason: 'task' }, f.exec).then(() => null, value => value)
        assert.equal(error.code, code); assert.match(error.message, new RegExp(`^\\[${code}\\]`))
        assert.equal(/Users|private|token|secret/.test(error.message), false)
        const diagnostic = projectHarnessComputerToolErrors([{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name }] }, { role: 'tool', toolCallId: 'call', isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }])
        assert.deepEqual(diagnostic, [{ tool: name, code }])
      }
    } finally { f.dispose() }
  }
})

test('unknown or forged error codes are replaced by a generic safe entry error', async () => {
  const f = fixture(Object.assign(new Error('credential or /private/path'), { code: 'UNKNOWN_/private/path' }))
  try {
    const error = await f.tools.get('qiuya_computer_discover').execute({}, f.exec).then(() => null, value => value)
    assert.equal(error.code, 'COMPUTER_ENTRY_FAILED'); assert.equal(/credential|private|path/.test(error.message), false)
    const malformed = await f.tools.get('qiuya_computer_discover').execute({ appId: 'self-grant' }, f.exec).then(() => null, value => value)
    assert.match(malformed.message, /^\[INVALID_REQUEST\]/u)
  } finally { f.dispose() }
})

test('diagnostic projection retains only scoped finite error codes, not arbitrary texts/keys/paths', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'request', name: 'qiuya_computer_request_control' }, { type: 'tool-call', id: 'other', name: 'unrelated_tool' }] },
    { role: 'tool', toolCallId: 'request', isError: true, content: [{ type: 'text', text: 'Error: [SYSTEM_PERMISSION_REQUIRED] token=private-secret /Users/person/app' }], error: { code: 'arbitrary-secret', text: 'secret' } },
    { role: 'tool', toolCallId: 'other', isError: true, content: [{ type: 'text', text: '[APPROVAL_DISABLED] secret' }] },
  ]
  assert.deepEqual(projectHarnessComputerToolErrors(messages), [{ tool: 'qiuya_computer_request_control', code: 'SYSTEM_PERMISSION_REQUIRED' }])
  assert.equal(/secret|person|token/.test(JSON.stringify(projectHarnessComputerToolErrors(messages))), false)
})

test('actual serialized browser diagnostic retains routed focus metadata and only the requested disposable session', async () => {
  const sessionId = 'owned-sid', snapshot = { sessionId, state: 'paused', epoch: 4, error: { code: 'HUMAN_INPUT_INTERRUPTED', message: 'PRIVATE_MESSAGE' } }
  const native = { available: true, platform: 'darwin', focusAttempt: { inputRoute: 'keyboard', inputRouteStage: 'keyboard-root', keyboardFocusStage: 'geometry', keyboardAXError: -25204,
    inputRouteChecks: 5, inputRouteMs: 12, keyboardFocusAccepted: false, inputRouteAccepted: false, inputPosted: false, PRIVATE_FIELD: 'PRIVATE_VALUE' } }
  const run = vm.runInNewContext(`(${captureHarnessComputerDiagnostic.toString()})`, { AbortSignal, crypto: { randomUUID: () => 'own-rpc' }, fetch: async () => ({ ok: true, json: async () => ({ result: { ok: true, value: { sessions: [{ sessionId: 'not-owned', error: { message: 'PRIVATE_OTHER' } }, snapshot], native } } }) }) })
  const result = await run({ sessionId, codes: HARNESS_COMPUTER_DIAGNOSTIC_CODES })
  assert.equal(result.session.sessionId, sessionId); assert.equal(result.session.error.code, 'HUMAN_INPUT_INTERRUPTED')
  assert.equal(result.native.focusAttempt.inputRoute, 'keyboard'); assert.equal(result.native.focusAttempt.keyboardAXError, -25204); assert.equal(result.native.focusAttempt.inputRouteChecks, 5)
  assert.equal(result.native.focusAttempt.keyboardFocusAccepted, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|not-owned/u)
  native.focusAttempt.inputRouteStage = 'PRIVATE_STAGE'; native.focusAttempt.keyboardAXError = Infinity
  const unknown = await run({ sessionId, codes: HARNESS_COMPUTER_DIAGNOSTIC_CODES })
  assert.equal(unknown.native.focusAttempt.inputRouteStage, null); assert.equal(unknown.native.focusAttempt.keyboardAXError, null)
  for (const code of ['HUMAN_INPUT_INTERRUPTED', 'CURSOR_CLEANUP_FAILED']) {
    const projected = projectHarnessComputerToolErrors([{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'qiuya_computer_act' }] }, { role: 'tool', toolCallId: 'call', isError: true, content: [{ type: 'text', text: `[${code}] PRIVATE_MESSAGE` }] }])
    assert.deepEqual(projected, [{ tool: 'qiuya_computer_act', code }])
  }
})


test('uncertain application launch tells the owner to reconnect without exposing data or directing a model retry', async () => {
  const f = fixture(Object.assign(new Error('/private/app?token=secret'), { code: 'APPLICATION_LAUNCH_UNCONFIRMED' }))
  try {
    const error = await f.tools.get('qiuya_computer_request_control').execute({ candidateId: 'one', reason: 'task' }, f.exec).then(() => null, value => value)
    assert.equal(error.code, 'APPLICATION_LAUNCH_UNCONFIRMED')
    assert.equal(error.message, '[APPLICATION_LAUNCH_UNCONFIRMED] 应用启动结果尚未确认，请由用户重新连接电脑后再继续。')
    assert.equal(/重试|重新启动|private|token|secret/u.test(error.message), false)
    assert.deepEqual(projectHarnessComputerToolErrors([{ role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'qiuya_computer_request_control' }] }, { role: 'tool', toolCallId: 'call', isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] }]), [{ tool: 'qiuya_computer_request_control', code: 'APPLICATION_LAUNCH_UNCONFIRMED' }])
  } finally { f.dispose() }
})
