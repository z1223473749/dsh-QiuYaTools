import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { setTimeout as delay } from 'node:timers/promises'

// Uses the actual production server, native driver and CLI in a disposable
// directory. Only the stdin JSON companion is synthetic; it cannot post input.
for (const code of [0, 7]) test(`remote shutdown records native exit ${code} and requires actual revoked-token rejection`, { timeout: 12000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qiuya-remote-shutdown-'))
  let child
  try {
    await mkdir(join(root, 'lib')); await mkdir(join(root, 'scripts'))
    await copyFile(new URL('./fixtures/windows-remote-agent.mjs', import.meta.url), join(root, 'remote-agent.mjs'))
    await copyFile(new URL('../scripts/computer-agent.mjs', import.meta.url), join(root, 'scripts/computer-agent.mjs'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'token.txt'), 'a'.repeat(64))
    await build({ stdin: { contents: "export{createComputerAgentServer}from'./src/features/computer-use/remote.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts'", resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'lib/computer-agent.js') })
    const fake = join(root, 'no-input.cjs')
    await writeFile(fake, String.raw`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.op!=='status')throw Error('No input operation is permitted');process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true,result:{available:true,protocolVersion:1,platform:'win32'}})+'\n')});rl.on('close',()=>process.exit(${code}));`)
    child = spawn(process.execPath, [join(root, 'remote-agent.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QIUYA_COMPUTER_TOKEN_FILE: join(root, 'token.txt'), QIUYA_COMPUTER_NATIVE_EXECUTABLE: process.execPath, QIUYA_COMPUTER_NATIVE_ARGS: JSON.stringify([fake]), QIUYA_COMPUTER_HOST: '127.0.0.1', QIUYA_COMPUTER_PORT: '0' } })
    let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value }); child.stdout.resume()
    const exited = new Promise((done, reject) => { child.once('exit', (exitCode, signal) => done({ code: exitCode, signal })); child.once('error', reject) })
    let started
    for (let index = 0; index < 200; index++) {
      try { started = JSON.parse(await readFile(join(root, 'agent-started.json'), 'utf8')); break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (child.exitCode !== null) throw new Error('Agent failed startup: ' + stderr)
      await delay(10)
    }
    assert.ok(started?.nativePid)
    const response = await fetch(started.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, requestId: 9, clientId: 'test', op: 'status', payload: {} }) })
    assert.equal(response.status, 200); await response.arrayBuffer()
    child.stdin.end('quit\n')
    const exit = await exited, receipt = JSON.parse(await readFile(join(root, 'agent-cleanup.json'), 'utf8'))
    assert.deepEqual(exit, { code: code === 0 ? 0 : 1, signal: null })
    assert.equal(receipt.oldTokenRejected, true)
    assert.deepEqual(receipt.nativeExit, { code, signal: null })
    assert.equal(receipt.passed, code === 0)
    await assert.rejects(readFile(join(root, 'token.txt')), { code: 'ENOENT' })
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})
