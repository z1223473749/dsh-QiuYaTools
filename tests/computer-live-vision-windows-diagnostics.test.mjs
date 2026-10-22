import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWindowsCarrierDiagnostics, projectWindowsCarrierError } from '../scripts/live-vision-windows-diagnostics.mjs'
import { windowsVisionPrincipalQuery } from '../scripts/live-vision-windows-carrier.mjs'

const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')

test('principal command uses separate property and comparison operator tokens in the simplified Where-Object pipeline',()=>{
 assert.match(windowsVisionPrincipalQuery,/\|Where-Object SessionId -gt 0\|Select-Object -First 1/u)
 assert.equal(windowsVisionPrincipalQuery.includes('Where-Object SessionId-gt'),false)
})

test('carrier diagnostics preserve numeric process exit and finite PowerShell category without raw text',()=>{
 const secret = 'private-command-and-account-value'
 const error = Object.assign(Error(secret), { code: 17, stdout: secret, stderr: `ParserError: ${secret}`, signal: null })
 const projected = projectWindowsCarrierError(error)
 assert.equal(projected.category,'process-exit');assert.equal(projected.exitCode,17);assert.equal(projected.code,null);assert.equal(projected.powershellCategory,'parser')
 assert.deepEqual(projected.stdout,{available:true,bytes:Buffer.byteLength(secret),sha256:hash(secret)})
 assert.equal(JSON.stringify(projected).includes(secret),false)
 assert.equal(projectWindowsCarrierError({code:'EPERM'}).code,'EPERM')
 assert.equal(projectWindowsCarrierError({code:'EADDRNOTAVAIL'}).code,'EADDRNOTAVAIL')
 assert.equal(projectWindowsCarrierError({code:'VISION_WINDOWS_PS_ENVELOPE'}).category,'policy')
 const unknown=projectWindowsCarrierError({code:secret});assert.equal(unknown.code,null);assert.equal(unknown.unknownCode.sha256,hash(secret));assert.equal(JSON.stringify(unknown).includes(secret),false)
})

test('actual child failure persists stage before execution and stdout/stderr digests before rethrow',async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'qiuya-carrier-diagnostic-'))), secret='synthetic-private-fixture-value'
 try {
  const diagnostics=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:directory})
  let actualError
  await assert.rejects(diagnostics.stage('query-interactive-principal',()=>diagnostics.command('windows-short-powershell',async()=>{
   assert.equal((await readdir(directory)).length,2)
   try { return await exec(process.execPath,['-e',`process.stdout.write(${JSON.stringify(secret)});process.stderr.write('ParserError:'+${JSON.stringify(secret)});process.exit(17)`]) }
   catch(error){actualError=error;throw error}
  })),error=>error.code===17)
  const receipts=await Promise.all((await readdir(directory)).sort().map(name=>readFile(join(directory,name),'utf8').then(JSON.parse)))
  assert.deepEqual(receipts.map(x=>[x.kind,x.phase]),[['stage','started'],['command','started'],['command','failed'],['stage','failed']])
  assert.equal(receipts[2].error.exitCode,17);assert.equal(receipts[2].error.powershellCategory,'parser');assert.equal(receipts[2].error.stdout.sha256,hash(secret))
  assert.equal(diagnostics.failure(actualError).stage,'query-interactive-principal');assert.equal(diagnostics.failure(actualError).command,'windows-short-powershell')
  assert.equal(JSON.stringify(receipts).includes(secret),false)
 } finally {await rm(directory,{recursive:true,force:true})}
})

test('failed pre-action receipt prevents side effects and unclassified error still has a finite failure stage',async()=>{
 let created=false
 const blocked=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:'/unused',writeReceipt:async()=>{throw Object.assign(Error('private storage detail'),{code:'EPERM'})}})
 await assert.rejects(blocked.stage('create-guest-root',async()=>{created=true}),{code:'EPERM'});assert.equal(created,false)
 const receipts=[],diagnostics=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:'/unused',writeReceipt:async(path,value)=>receipts.push(value)})
 const error=Error('private unknown bootstrap error')
 await assert.rejects(diagnostics.stage('listen-private-bridge',async()=>{throw error}))
 assert.equal(diagnostics.failure(error).stage,'listen-private-bridge');assert.equal(diagnostics.failure(error).error.category,'unclassified');assert.equal(receipts.at(-1).phase,'failed')
 assert.equal(JSON.stringify(receipts).includes(error.message),false)
})

test('a diagnostic write failure after a failed command preserves the original exit and never executes twice',async()=>{
 let writes=0,issued=0
 const diagnostics=createWindowsCarrierDiagnostics({runId:randomUUID(),evidence:'/unused',writeReceipt:async()=>{if(++writes>2)throw Object.assign(Error('private storage detail'),{code:'EPERM'})}})
 const original=Object.assign(Error('private process failure'),{code:23,stderr:'ParserError: private syntax'})
 await assert.rejects(diagnostics.stage('query-interactive-principal',()=>diagnostics.command('windows-short-powershell',async()=>{issued++;throw original})),error=>error===original)
 assert.equal(issued,1);assert.equal(diagnostics.failure(original).error.exitCode,23);assert.equal(diagnostics.failure(original).receiptError.code,'EPERM')
})
