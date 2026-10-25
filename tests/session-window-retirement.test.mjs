import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'qiuya-session-retirement-'))
test.after(() => rm(root, { recursive: true, force: true }))
const output = await build({ entryPoints: ['src/features/session-windows/host.ts'], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
const hostModule = join(root, 'host.mjs')
await writeFile(hostModule, output.outputFiles[0].text)
const { SessionWindowCompanion } = await import(pathToFileURL(hostModule).href)
let sequence = 0
async function worker({ unexpected = false, code = 0 } = {}) {
  const file = join(root, `worker-${++sequence}.cjs`)
  const late = `setTimeout(()=>process.stdout.write('owned-final-tail\\n'),90)`
  await writeFile(file, `const {spawn}=require('node:child_process');const retire=()=>{const p=spawn(process.execPath,['-e',${JSON.stringify(late)}],{stdio:['ignore',1,'ignore']});p.unref();process.exit(${code})};const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({requestId:r.requestId,ok:true})+'\\n',()=>{if(${unexpected})retire()})});rl.on('close',retire);`)
  return new SessionWindowCompanion(process.execPath, [file])
}
for (const unexpected of [false, true]) test(`session disposal drains the original stdout after ${unexpected ? 'an earlier unexpected exit' : 'EOF exit'}`, async () => {
  const companion = await worker({ unexpected })
  await companion.open({ sessionId: 'isolated-tail' })
  const child = companion.child, events = [], chunks = []
  assert(child)
  child.stdout.on('data', chunk => { chunks.push(String(chunk)); if (String(chunk).includes('owned-final-tail')) events.push('tail') })
  child.once('exit', () => { events.push('exit'); assert(child.stdout.listenerCount('data') >= 2, 'readline must remain attached until stdio closes') })
  child.once('close', () => events.push('close'))
  if (unexpected) await once(child, 'exit')
  await companion.dispose(); events.push('disposed')
  assert(chunks.join('').includes('owned-final-tail'))
  assert.deepEqual(events, ['exit', 'tail', 'close', 'disposed'])
})
test('normal session disposal rejects a nonzero native exit', async () => {
  const companion = await worker({ code: 1 })
  await companion.open({ sessionId: 'isolated-nonzero' })
  await assert.rejects(companion.dispose(), /未正常退出/u)
})
for (const alreadyClosed of [false, true]) test(`an earlier nonzero session exit remains a cleanup failure ${alreadyClosed ? 'after' : 'before'} stdio close`, async () => {
  const companion = await worker({ unexpected: true, code: 1 })
  await companion.open({ sessionId: 'isolated-earlier-nonzero' })
  const child = companion.child, exited = once(child, 'exit'), closed = once(child, 'close')
  await exited
  if (alreadyClosed) await closed
  await assert.rejects(companion.dispose(), /未正常退出/u)
  await closed
})
