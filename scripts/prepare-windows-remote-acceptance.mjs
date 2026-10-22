/** Prepare an immutable, zero-GUI Mac to Windows acceptance carrier. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,realpath,rm} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {join,resolve} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {build} from 'esbuild'
const root=fileURLToPath(new URL('../',import.meta.url)),id=randomUUID(),base=join(root,'artifacts/computer-use/macos-to-windows-strict-prepared-'+id),snapshot=join(base,'snapshot')
await mkdir(snapshot,{recursive:true})
const hash=value=>createHash('sha256').update(value).digest('hex'),sourceHashes={},snapshotHashes={}
const own=['scripts/prepare-windows-remote-acceptance.mjs','scripts/e2e-windows-remote-pd.mjs','scripts/windows-remote-delivery.mjs','scripts/computer-webview2-soak-evidence.mjs','scripts/computer-agent.mjs','tests/fixtures/windows-remote-agent.mjs','tests/fixtures/windows-remote-audit.cs','tests/fixtures/windows-remote-binding.csproj','tests/fixtures/windows-remote-binding-main.cs','src/native/windows/remote-e2e.ps1','src/native/windows/remote-relay.mjs','tests/windows-remote-delivery.test.mjs','tests/windows-remote-agent.test.mjs','tests/windows-remote-binding.test.mjs']
const dep=await build({stdin:{contents:"export{RemoteComputerDriver,createComputerAgentServer}from'./src/features/computer-use/remote.ts';export{NativeCompanionDriver}from'./src/features/computer-use/native.ts'",resolveDir:root},bundle:true,write:false,platform:'node',format:'esm',metafile:true})
for(const path of new Set([...own,...Object.keys(dep.metafile.inputs).filter(path=>path!=='<stdin>')]))sourceHashes[path]=hash(await readFile(resolve(root,path)))
// Discover the complete static module closure instead of maintaining a partial
// hand-written list. External Node packages remain resolved by the reviewed repo.
const snapshotGraph=await build({entryPoints:[join(root,'scripts/e2e-windows-remote-pd.mjs')],absWorkingDir:root,bundle:true,packages:'external',platform:'node',format:'esm',write:false,metafile:true})
for(const name of Object.keys(snapshotGraph.metafile.inputs)){
 assert.ok(!name.startsWith('..')&&!name.startsWith('/'),'Snapshot dependency escaped the repository')
 const contentBefore=await readFile(join(root,name),'utf8')
 let content=contentBefore
 if(name==='scripts/e2e-windows-remote-pd.mjs')content=content.replace("repo = fileURLToPath(new URL('../', import.meta.url))",'repo = '+JSON.stringify(root))
 const destination=join(snapshot,name)
 await mkdir(join(destination,'..'),{recursive:true});await writeFile(destination,content)
 sourceHashes[name]=hash(Buffer.from(contentBefore));snapshotHashes[name]=hash(Buffer.from(content))
}
const smokeProgram=String.raw`import assert from'node:assert/strict';try{await import(process.argv[1]);throw Error('Unexpected execution beyond import-only gate')}catch(error){assert.equal(error.message,'Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized Mac and selected test VM');console.log(JSON.stringify({passed:true,staticModuleClosureResolved:true,entryValidationReached:true,pdCommandsExecuted:0,guiStarted:0}))}`
const smokeEnv={...process.env};delete smokeEnv.QIUYA_PD_VM;delete smokeEnv.QIUYA_PD_HOST_IP
const execute=promisify(execFile)
const smoke=JSON.parse((await execute(process.execPath,['--input-type=module','-e',smokeProgram,pathToFileURL(join(snapshot,'scripts/e2e-windows-remote-pd.mjs')).href],{env:smokeEnv,timeout:15000})).stdout.trim())
assert.equal(smoke.passed,true)
await writeFile(join(base,'snapshot-import-smoke.json'),JSON.stringify(smoke,null,2))
// Negative control proves this smoke detects the actual omitted transitive
// dependency, rather than checking syntax or importing only the top module.
const negative=join(base,'negative-import-control')
await mkdir(negative)
for(const name of Object.keys(snapshotHashes)){if(name==='scripts/computer-soak-evidence.mjs')continue;const destination=join(negative,name);await mkdir(join(destination,'..'),{recursive:true});await writeFile(destination,await readFile(join(snapshot,name)))}
const negativeProgram=String.raw`import assert from'node:assert/strict';try{await import(process.argv[1]);throw Error('Missing dependency was accepted')}catch(error){assert.equal(error.code,'ERR_MODULE_NOT_FOUND');assert.ok(error.message.includes('/scripts/computer-soak-evidence.mjs'));console.log(JSON.stringify({passed:true,missingTransitiveDependencyRejected:true,pdCommandsExecuted:0,guiStarted:0}))}`
const negativeSmoke=JSON.parse((await execute(process.execPath,['--input-type=module','-e',negativeProgram,pathToFileURL(join(negative,'scripts/e2e-windows-remote-pd.mjs')).href],{env:smokeEnv,timeout:15000})).stdout.trim())
assert.equal(negativeSmoke.passed,true);await writeFile(join(base,'missing-transitive-import-control.json'),JSON.stringify(negativeSmoke,null,2));await rm(negative,{recursive:true})
const helper=await realpath(join(root,'lib/native/win32-arm64/qiuya-windows.exe')),helperSHA256=hash(await readFile(helper));assert.equal(helperSHA256,'c8be449dc66b1d537a80f381425597c2a81dcc87e55eec8a4a5baac0b4a559ce')
const nodeArchivePath='/private/tmp/qyt-node-v22.23.3-win-arm64.zip',nodeArchiveSHA256=hash(await readFile(nodeArchivePath))
const data={id,root,preparedAt:new Date().toISOString(),sourceHashes,snapshotHashes,helper,helperSHA256,nodeArchivePath,nodeArchiveSHA256,vm:'ffba3614-b0e4-4b38-b185-b9a4b7ba5aec',host:'10.211.55.2',output:'/Users/qiuya/QiuYaTools-验收/2026-10-22/Mac到Windows-严格收尾-'+id,snapshotImportSmoke:smoke,missingTransitiveImportControl:negativeSmoke,guiStarted:false,pdCommandsExecuted:false,pureTestCommands:['QIUYA_DOTNET=/private/tmp/qyt-dotnet-sdk/dotnet node --test tests/windows-remote-binding.test.mjs tests/windows-remote-delivery.test.mjs tests/windows-remote-agent.test.mjs'],actualOsInput:false,actualDesktopCapture:false}
const entry=String.raw`import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir}from'node:fs/promises'
import {dirname,join}from'node:path'
import{fileURLToPath}from'node:url'
import{createHash}from'node:crypto'
import{execFile,spawn}from'node:child_process'
import{promisify}from'node:util'
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),hash=value=>createHash('sha256').update(value).digest('hex'),execute=promisify(execFile)
const running=process.argv.includes('--run'),planning=process.argv.includes('--plan'),arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
assert.notEqual(running,planning,'Pass --plan or --run')
assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256,'Prepared entry changed')
async function verify(){for(const[path,expected]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(join(data.root,path))),expected,'Bound source changed: '+path);for(const[path,expected]of Object.entries(data.snapshotHashes))assert.equal(hash(await readFile(join(base,'snapshot',path))),expected,'Snapshot changed: '+path);assert.equal(hash(await readFile(data.helper)),data.helperSHA256,'Windows PE changed');assert.equal(hash(await readFile(data.nodeArchivePath)),data.nodeArchiveSHA256,'Node archive changed')}
await verify()
const smokeEnv={...process.env};delete smokeEnv.QIUYA_PD_VM;delete smokeEnv.QIUYA_PD_HOST_IP
const smokeProgram="import assert from'node:assert/strict';try{await import(process.argv[1]);throw Error('Unexpected execution beyond import-only gate')}catch(error){assert.equal(error.message,'Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the authorized Mac and selected test VM');console.log(JSON.stringify({passed:true,staticModuleClosureResolved:true,entryValidationReached:true,pdCommandsExecuted:0,guiStarted:0}))}"
const smoke=JSON.parse((await execute(process.execPath,['--input-type=module','-e',smokeProgram,new URL('./snapshot/scripts/e2e-windows-remote-pd.mjs',import.meta.url).href],{env:smokeEnv,timeout:15000})).stdout.trim());assert.equal(smoke.passed,true)
if(planning){console.log(JSON.stringify({...data,guiStarted:false,pdCommandsExecuted:false,externalDirectoryWritten:false},null,2));process.exit(0)}
assert.equal(arg('--gui-gate'),'root-approved','Root must own the Windows input slot')
await mkdir(data.output)
await writeFile(join(data.output,'carrier-binding.json'),JSON.stringify({...data,entrySHA256:data.entrySHA256,isolatedFixtureOnly:true,noMacInput:true},null,2),{mode:0o600})
const prlctl='/Applications/Parallels Desktop.app/Contents/MacOS/prlctl'
let priorPause,pauseRestored=false,childExit,failure,sourceUnchanged=false,stdout='',stderr=''
try{
 const before=(await execute(prlctl,['list','--info',data.vm],{timeout:30000,killSignal:'SIGKILL'})).stdout
 priorPause=/Pause idle: (on|off)/u.exec(before)?.[1];assert.ok(priorPause,'VM idle-pause state unavailable')
 await execute(prlctl,['set',data.vm,'--pause-idle','off'],{timeout:30000,killSignal:'SIGKILL'})
 childExit=await new Promise((done,reject)=>{
  const child=spawn(process.execPath,[join(base,'snapshot/scripts/e2e-windows-remote-pd.mjs')],{cwd:data.root,env:{...process.env,QIUYA_PD_VM:data.vm,QIUYA_PD_HOST_IP:data.host,QIUYA_WINDOWS_HELPER:data.helper,QIUYA_WINDOWS_NODE_ZIP:data.nodeArchivePath,QIUYA_WINDOWS_REMOTE_OUTPUT:data.output},stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',value=>{stdout=(stdout+value).slice(-8*1024*1024)});child.stderr.on('data',value=>{stderr=(stderr+value).slice(-2*1024*1024)})
  child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal,runnerPid:child.pid}))
 })
 assert.deepEqual({code:childExit.code,signal:childExit.signal},{code:0,signal:null},'Strict Mac to Windows runner did not pass and exit naturally')
}catch(error){failure={message:error.message,code:error.code??null}}
finally{
 if(priorPause)try{await execute(prlctl,['set',data.vm,'--pause-idle',priorPause],{timeout:30000,killSignal:'SIGKILL'});const info=(await execute(prlctl,['list','--info',data.vm],{timeout:30000,killSignal:'SIGKILL'})).stdout;pauseRestored=new RegExp('Pause idle: '+priorPause).test(info);assert.ok(pauseRestored,'VM idle-pause was not restored')}catch(error){failure??={message:error.message}}
 try{await verify();sourceUnchanged=true}catch(error){failure??={message:error.message}}
 await writeFile(join(data.output,'carrier-stdout.log'),stdout,{mode:0o600});await writeFile(join(data.output,'carrier-stderr.log'),stderr,{mode:0o600})
 let verdict;try{verdict=JSON.parse(await readFile(join(data.output,'delivery-verdict.json'),'utf8'))}catch{failure??={message:'Strict delivery verdict missing'}}
 const passed=!failure&&sourceUnchanged&&pauseRestored&&verdict?.passed===true
 await writeFile(join(data.output,'carrier-verdict.json'),JSON.stringify({passed,preparedId:data.id,childExit,failure,sourceUnchanged,priorPause,pauseRestored,actual:verdict??null},null,2),{mode:0o600})
 console.log(JSON.stringify({passed,output:data.output,failure,sourceUnchanged,pauseRestored,actual:verdict??null},null,2));if(!passed)process.exitCode=1
}
`
await writeFile(join(base,'entry.mjs'),entry);data.entrySHA256=hash(Buffer.from(entry));await writeFile(join(base,'prepare-data.json'),JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({entry:join(base,'entry.mjs'),id,output:data.output,helperSHA256,sourceCount:Object.keys(sourceHashes).length},null,2))
