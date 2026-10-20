/** Test-only reverse tunnel: exposes no arbitrary guest command, filesystem, or destination. */
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const endpoint = new URL(config.endpoint)
if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('The test tunnel only forwards to the local paired agent')
const socket = connect({ host: config.host, port: config.port })
await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject) })
socket.write(JSON.stringify({ hello: config.secret }) + '\n')
const lines = createInterface({ input: socket })
lines.on('line', line => {
  if (line.length > 1024 * 1024) { socket.destroy(); return }
  void (async () => {
    const request = JSON.parse(line)
    if (!Number.isSafeInteger(request.id) || request.method !== 'POST') throw new Error('Invalid test tunnel envelope')
    const response = await fetch(endpoint, { method: 'POST', headers: request.headers, body: Buffer.from(request.body, 'base64'), redirect: 'error', signal: AbortSignal.timeout(25000) })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 48 * 1024 * 1024) throw new Error('Test tunnel response limit')
    socket.write(JSON.stringify({ id: request.id, status: response.status, body: bytes.toString('base64') }) + '\n')
  })().catch(() => { socket.destroy() })
})
socket.once('close', () => { lines.close(); process.exit() })
