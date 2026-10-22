/** Test-only stdin shutdown around the unmodified production paired agent. */
import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { main } from './scripts/computer-agent.mjs'

const root = dirname(fileURLToPath(import.meta.url)), errors = []
const save = async (name, value) => { const path = join(root, name); await writeFile(path + '.tmp', JSON.stringify(value)); await rename(path + '.tmp', path) }
const server = await main()
const status = await server.driver.status()
if (status.available !== true) { await server.close(); throw new Error('The production native companion is unavailable: ' + (status.message ?? 'unknown')) }
// Read-only observation of this test instance's transport child. The production
// dispose path remains responsible for EOF and input release.
const native = server.driver.child
if (!native?.pid) throw new Error('The production agent did not start its native child')
const nativeExit = new Promise(done => { native.once('exit', (code, signal) => done({ code, signal })); native.once('error', error => done({ error: error.message })) })
await save('agent-started.json', { pid: process.pid, nativePid: native.pid, endpoint: server.agent.endpoint, nodeVersion: process.version, architecture: process.arch, platform: process.platform })
const lines = createInterface({ input: process.stdin })
let closing
async function shutdown() {
  if (closing) return closing
  closing = (async () => {
    let oldTokenRejected = false, exit
    try {
      const token = (await readFile(join(root, 'token.txt'), 'utf8')).trim()
      await server.agent.revoke()
      const response = await fetch(server.agent.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, requestId: 1, clientId: 'retired-token-check', op: 'status', payload: {} }), signal: AbortSignal.timeout(3000) })
      oldTokenRejected = response.status === 401
      if (!oldTokenRejected) errors.push('The revoked pairing token was not rejected')
    } catch (error) { errors.push('Revoke: ' + error.message) }
    try { await server.close() } catch (error) { errors.push('Production agent close: ' + error.message) }
    let timer
    try { exit = await Promise.race([nativeExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native natural exit deadline')), 5000) })]) }
    catch (error) { errors.push(error.message) } finally { clearTimeout(timer) }
    if (exit?.code !== 0 || exit?.signal !== null) errors.push('Native companion did not exit naturally with code zero')
    try { await unlink(join(root, 'token.txt')) } catch (error) { if (error.code !== 'ENOENT') errors.push('Token deletion: ' + error.message) }
    await save('agent-cleanup.json', { passed: errors.length === 0, errors, oldTokenRejected, nativeExit: exit ?? null })
    lines.close(); process.stdin.pause()
    if (errors.length) process.exitCode = 1
  })()
  return closing
}
lines.on('line', line => { if (line !== 'quit') { errors.push('Unexpected test shutdown command'); return } void shutdown() })
lines.once('close', () => { void shutdown() })
