#!/usr/bin/env node
/** Dedicated paired guest agent; no arbitrary command or shell endpoint. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function main(environment = process.env) {
  if (process.versions.node.split('.')[0] < 22) throw new Error('Computer agent requires Node.js 22 or newer')
  const token = environment.QIUYA_COMPUTER_TOKEN_FILE
    ? (await readFile(resolve(environment.QIUYA_COMPUTER_TOKEN_FILE), 'utf8')).trim()
    : environment.QIUYA_COMPUTER_TOKEN
  if (!token) throw new Error('Set QIUYA_COMPUTER_TOKEN_FILE or QIUYA_COMPUTER_TOKEN to a private pairing token (32+ characters)')
  const { createComputerAgentServer, NativeCompanionDriver } = await import(new URL('../lib/computer-agent.js', import.meta.url).href)
  const nativeArgs = environment.QIUYA_COMPUTER_NATIVE_ARGS ? JSON.parse(environment.QIUYA_COMPUTER_NATIVE_ARGS) : undefined
  if (nativeArgs !== undefined && (!Array.isArray(nativeArgs) || nativeArgs.some(value => typeof value !== 'string'))) throw new Error('QIUYA_COMPUTER_NATIVE_ARGS must be a JSON string array')
  const driver = new NativeCompanionDriver({ executable: environment.QIUYA_COMPUTER_NATIVE_EXECUTABLE, args: nativeArgs })
  const port = Number(environment.QIUYA_COMPUTER_PORT ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('QIUYA_COMPUTER_PORT must be between 0 and 65535')
  const agent = await createComputerAgentServer(driver, { token, host: environment.QIUYA_COMPUTER_HOST ?? '127.0.0.1', port })
  process.stdout.write(`Computer agent listening: ${agent.endpoint}\nPairing credentials are never printed. Default binding is loopback; use a trusted TLS or SSH tunnel for another device.\n`)
  let closing = false
  const close = async () => { if (closing) return; closing = true; await agent.close(); driver.dispose() }
  process.once('SIGINT', () => { void close() }); process.once('SIGTERM', () => { void close() })
  return { agent, driver, close }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Agent failed'}\n`); process.exitCode = 1 })
}
