/** Prepare only: pin the unchanged real helper and diagnostic runner, no GUI. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { build } from 'esbuild'
// Source-only current66ae diagnostics never enter the legacy0143 build/GUI carrier.
if (process.argv.includes('--cursor-source-only')) {
  const { prepareMacCursorSourceSnapshot } = await import('./macos-cursor-diagnostic-core.mjs')
  const prepared = await prepareMacCursorSourceSnapshot({ root: fileURLToPath(new URL('../', import.meta.url)) })
  console.log(JSON.stringify({ base: prepared.base, kind: prepared.kind, helperSHA256: prepared.helperSHA256, buildPending: true, compileExecuted: false, guiStarted: 0, inputActions: 0 }, null, 2))
  process.exit(0)
}
const root=fileURLToPath(new URL('../',import.meta.url)),id=randomUUID(),base=join(root,'artifacts/computer-use/macos-manager-held-diagnostic-prepared-'+id),hash=value=>createHash('sha256').update(value).digest('hex')
const helper=await realpath(join(root,'lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer')),helperSHA256=hash(await readFile(helper))
assert.equal(helperSHA256,'0143cd944934872fc567dd420da2d44d269ac0150b7d243cacf321537f17264a','This carrier requires the same formal helper as the preceding actual run')
const graph=await build({stdin:{contents:"export{installComputerHost}from'./src/features/computer-use/host.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts';export{ScheduledComputerDriver}from'./src/features/computer-use/scheduled-driver.ts'",resolveDir:root},bundle:true,write:false,metafile:true,platform:'node',format:'esm'})
const sources=['scripts/prepare-macos-multitask-acceptance.mjs','scripts/test-macos-multitask-manager.mjs','scripts/macos-cursor-diagnostic-core.mjs','tests/macos-multitask-runner.test.mjs','src/native/macos/fixtures/AICursorFixture.swift','src/native/macos/fixtures/AICursorObserver.swift','src/native/macos/fixtures/LeaseOracle.swift','lib/macos-manifest.json','lib/QiuYaTools Computer.app/Contents/Info.plist',...Object.keys(graph.metafile.inputs).filter(name=>name!=='<stdin>')]
const sourceHashes={};for(const path of new Set(sources))sourceHashes[path]=hash(await readFile(resolve(root,path)))
await mkdir(base)
const data={id,root,base,helper,helperSHA256,sourceHashes,preparedAt:new Date().toISOString(),output:'/Users/qiuya/QiuYaTools-验收/2026-10-22/Mac-双会话-held诊断-'+id,kind:'actual-default-manager-with-finite-held-diagnostics',maximumHeldObservationMs:1800,productionInputUnchanged:true,productionHelperUnchanged:true,replayedActions:0,guiStarted:0,pdCommandsExecuted:0,scope:'Original planned real input sequences only. Observe both original B FIFO drag and redock drag; native-hidden/zero-joint samples remain failures. First B visibility failure is retained and the run cannot pass after the original redock diagnostic. Critical lease/foreground drift still aborts. No installed Harness UI or resource endurance claim.'}
const entry=String.raw`import assert from'node:assert/strict'
import{readFile,writeFile,mkdir}from'node:fs/promises'
import{dirname,join,resolve,sep}from'node:path'
import{fileURLToPath}from'node:url'
import{createHash}from'node:crypto'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),hash=value=>createHash('sha256').update(value).digest('hex'),arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const running=process.argv.includes('--run'),planning=process.argv.includes('--plan');assert.notEqual(running,planning,'Pass --plan or --run')
assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256,'Prepared carrier changed')
async function verify(){for(const[path,expected]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(resolve(data.root,path))),expected,'Bound source changed: '+path);assert.equal(hash(await readFile(data.helper)),data.helperSHA256,'Formal0143 changed')}
await verify()
const output=resolve(arg('--out')||data.output),repo=resolve(data.root)
assert.ok(output!==repo&&!output.startsWith(repo+sep),'All actual evidence must be outside the Git project')
if(planning){console.log(JSON.stringify({...data,output,sourceCount:Object.keys(data.sourceHashes).length,guiStarted:0,pdCommandsExecuted:0,externalDirectoryWritten:false},null,2));process.exit(0)}
assert.equal(arg('--gui-gate'),'root-approved','Root must own the Mac input slot')
await mkdir(output)
await writeFile(join(output,'carrier-binding.json'),JSON.stringify({...data,output},null,2),{mode:0o600})
let result,failure,sourceUnchanged=false
try{result=await promisify(execFile)(process.execPath,[join(data.root,'scripts/test-macos-multitask-manager.mjs'),'--out',output,'--native',data.helper,'--expect-sha256',data.helperSHA256],{cwd:data.root,timeout:240000,maxBuffer:8*1024*1024})}catch(error){failure={message:String(error.message).slice(0,1000),code:error.code,signal:error.signal};result={stdout:error.stdout||'',stderr:error.stderr||''}}
await writeFile(join(output,'carrier-stdout.log'),result.stdout,{mode:0o600});await writeFile(join(output,'carrier-stderr.log'),result.stderr,{mode:0o600})
try{await verify();sourceUnchanged=true}catch(error){failure??={message:error.message}}
let actual;try{actual=JSON.parse(await readFile(join(output,'delivery-verdict.json'),'utf8'))}catch{failure??={message:'Actual default-manager delivery verdict missing'}}
const passed=!failure&&sourceUnchanged&&actual?.passed===true
await writeFile(join(output,'carrier-verdict.json'),JSON.stringify({passed,sourceUnchanged,failure:failure??null,actual,helperSHA256:data.helperSHA256,preparedId:data.id,output},null,2),{mode:0o600})
console.log(JSON.stringify({passed,output,sourceUnchanged,actual,failure},null,2));if(!passed)process.exitCode=1
`
await writeFile(join(base,'entry.mjs'),entry);data.entrySHA256=hash(Buffer.from(entry));await writeFile(join(base,'prepare-data.json'),JSON.stringify(data,null,2));console.log(JSON.stringify({entry:join(base,'entry.mjs'),output:data.output,sourceCount:Object.keys(sourceHashes).length,helperSHA256},null,2))
