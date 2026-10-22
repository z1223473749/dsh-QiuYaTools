import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {collectWindowsProcesses,validateCollectorRows,collectorCompileCommand,finiteSoakGateEvidence,invokeReadOnlyCollector} from '../scripts/windows-soak-process-collector.mjs'
import {createWebViewOwnershipTracker} from '../scripts/computer-webview2-soak-evidence.mjs'
import {prepareWindowsWebViewSoak} from '../scripts/prepare-windows-webview2-soak.mjs'
const execute=promisify(execFile),file='C:\\own-uuid\\windows-soak-process-collector.exe',bytes=Buffer.from('own executable bytes'),sha256=createHash('sha256').update(bytes).digest('hex')
const row=(pid,parentPid,name,path=file)=>({pid,parentPid,name,createdAtTicks:'639281324193729179',cimCreatedAtTicks:'639281324193729170',identityPrecision:'native-100ns-verified-against-CIM-microseconds',executablePath:path,workingSetBytes:123,privateBytes:80,cpuSeconds:1.25,ownedFixture:false,ownedWebView:false})
const rows=()=>[row(10,1,'node.exe','C:\\own-node\\node.exe'),row(11,10,'windows-soak-process-collector.exe')]
const filesystem={lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length}),readFile:async()=>bytes}
const options=extra=>({file,sha256,nativeData:'C:\\own-data',fixturePath:'C:\\own-fixture.ps1',parentPid:10,filesystem,...extra})

test('collector validates full finite schema, exact identity and its own included child row',()=>{
 const value=validateCollectorRows(JSON.stringify(rows()),{pid:11,parentPid:10,path:file})
 const owned=createWebViewOwnershipTracker()(value,10,'C:\\none\\qiuya-windows.exe')
 assert.deepEqual(owned.map(r=>r.pid),[10,11]);assert.equal(owned.reduce((s,r)=>s+r.workingSetBytes,0),246,'collector RSS is included without subtraction')
 for(const mutate of [r=>r.pop(),r=>r.push(r[1]),r=>r[1].commandLine='private text',r=>r[1].createdAtTicks='639281324193729189',r=>r[1].createdAtTicks=639281324193729179,r=>r[1].parentPid=99,r=>r[1].executablePath='C:\\other\\collector.exe',r=>r[1].workingSetBytes=-1,r=>r[1].privateBytes=1e30,r=>r[1].ownedWebView='false',r=>r[1].identityPrecision='cim-only']){
  const changed=rows();mutate(changed);assert.throws(()=>validateCollectorRows(JSON.stringify(changed),{pid:11,parentPid:10,path:file}))
 }
 const unavailable=rows();unavailable[0].createdAtTicks=null;unavailable[0].identityPrecision='unavailable'
 assert.equal(validateCollectorRows(JSON.stringify(unavailable),{pid:11,parentPid:10,path:file}).length,2)
 assert.throws(()=>createWebViewOwnershipTracker()(unavailable,10,''),/unavailable/,'unverifiable live owner cannot vanish from RSS')
 assert.throws(()=>validateCollectorRows('{}',{pid:11,parentPid:10,path:file}));assert.throws(()=>validateCollectorRows('{',{pid:11,parentPid:10,path:file}))
})

test('each invocation verifies exact executable SHA, fixed budgets, and actual normal exit',async()=>{
 let calls=0;const audit=[]
 const invoke=async(got,args,settings)=>{calls++;assert.equal(got,file);assert.deepEqual(args,['C:\\own-data','C:\\own-fixture.ps1']);assert.deepEqual(settings,{timeout:20000,maxBuffer:8*1024*1024,windowsHide:true,encoding:'utf8'});return{pid:11,stdout:JSON.stringify(rows()),stderr:'',code:0,signal:null,killed:false}}
 await collectWindowsProcesses(options({invoke,audit}));assert.equal(calls,1);assert.equal(audit[0].naturalExit,true);assert.equal(audit[0].selfIncluded,true)
 await assert.rejects(collectWindowsProcesses(options({invoke,sha256:'0'.repeat(64)})),/SHA changed/);assert.equal(calls,1)
 await assert.rejects(collectWindowsProcesses(options({invoke,filesystem:{...filesystem,lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>true,size:1})}})),/Invalid collector file/)
 for(const result of [{code:1},{signal:'SIGTERM'},{killed:true},{stderr:'failure'}])await assert.rejects(collectWindowsProcesses(options({invoke:async()=>({pid:11,stdout:JSON.stringify(rows()),stderr:'',code:0,signal:null,killed:false,...result})})),/normally/)
 const failed=[];await assert.rejects(collectWindowsProcesses(options({audit:failed,invoke:async()=>{const error=Error('timeout');error.collectorExit={pid:11,code:null,signal:'SIGTERM',killed:true};throw error}})),/timeout/);assert.equal(failed[0].naturalExit,false);assert.equal(failed[0].killed,true)
})

test('compile binding is own absolute paths + exact source SHA; never fallback or run during measurement',()=>{
 const command=collectorCompileCommand({source:'C:\\own\\collector.cs',output:file,sourceSha256:sha256})
 assert(command.includes('System.Management.dll'));assert(command.includes('System.Web.Extensions.dll'));assert(command.includes('ConsoleApplication'));assert(command.includes('compiledBeforeMeasurement=$true'));assert(command.includes('Collector output already exists'));assert(!/Kill\(|Stop-Process|Invoke-Expression/u.test(command))
 assert.throws(()=>collectorCompileCommand({source:'relative.cs',output:file,sourceSha256:sha256}));assert.throws(()=>collectorCompileCommand({source:file,output:file,sourceSha256:'bad'}))
})

test('finite failure evidence preserves exact whole-tree RSS including collector and original gates',()=>{
 const limits={ownedTreeRssBytes:1610612736},report={uniqueFps:11,endToEndFps:11,latencyP95Ms:39,invalidTimestamps:0,wrongDimensions:0,faults:[{}],generations:[{frames:1},{frames:1}],attachmentWrites:0,resourcesBounded:false,resourceBounds:{limits},cleanup:{passed:true},resources:[{elapsedMs:30,processes:[{name:'node.exe',workingSetBytes:100},{name:'windows-soak-process-collector.exe',workingSetBytes:50},{name:'powershell.exe',workingSetBytes:200}]}]}
 const evidence=finiteSoakGateEvidence(report,1);assert.deepEqual(evidence.failedGates,['resources']);assert.equal(evidence.samples[0].totalRssBytes,350);assert.equal(evidence.samples[0].roles.collector,50);assert.deepEqual(evidence.limits,limits);assert.equal(report.resourcesBounded,false)
 assert.deepEqual(finiteSoakGateEvidence({...report,resourcesBounded:true},1).failedGates,[],'a genuinely bounded passed report must not acquire a false resource failure')
 assert(finiteSoakGateEvidence({...report,latencyP95Ms:undefined},1).failedGates.includes('latency'))
})

test('actual child exit is awaited; abnormal exit and timeout cannot return normal success',async()=>{
 const result=await invokeReadOnlyCollector(process.execPath,['-e',"process.stdout.write('own-result')"],{timeout:2000,maxBuffer:8*1024*1024,encoding:'utf8'})
 assert.equal(result.stdout,'own-result');assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.killed,false)
 await assert.rejects(invokeReadOnlyCollector(process.execPath,['-e','process.exit(7)'],{timeout:2000,maxBuffer:8*1024*1024,encoding:'utf8'}),error=>error.collectorExit.code===7&&!error.collectorExit.killed)
 await assert.rejects(invokeReadOnlyCollector(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100,maxBuffer:8*1024*1024,encoding:'utf8'}),error=>error.collectorExit.killed===true)
})

test('C# core actually compiles/runs thirteen pure cases including missing live birth, without WMI or Windows execution',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'qyt-collector-selftest-'))
 try{
  await writeFile(join(directory,'Collector.cs'),await readFile(new URL('./fixtures/windows-soak-process-collector.cs',import.meta.url)))
  await writeFile(join(directory,'test.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><DefineConstants>COLLECTOR_SELF_TEST</DefineConstants><LangVersion>5</LangVersion><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>')
  const dotnet=process.env.QIUYA_DOTNET??'/private/tmp/qyt-dotnet-sdk/dotnet',env={...process.env,DOTNET_CLI_HOME:join(directory,'cli'),DOTNET_SKIP_FIRST_TIME_EXPERIENCE:'1',DOTNET_NOLOGO:'1'}
  await execute(dotnet,['build',join(directory,'test.csproj'),'--nologo','--verbosity','quiet'],{env,timeout:60000,maxBuffer:1024*1024})
  const result=await execute(dotnet,[join(directory,'bin/Debug/net8.0/test.dll')],{env,timeout:10000});assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{passed:true,checks:13,windowsWmiExecuted:false})
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('fresh x64 freeze closes collector imports/source, retains formal PE and 1.5GiB gates, rejects tampering before PD',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'qyt-collector-prepare-')),output=join(parent,'fresh')
 try{
  const made=await prepareWindowsWebViewSoak({output,architecture:'x64'}),manifest=JSON.parse(await readFile(join(output,'prepared.json'),'utf8'))
  assert.equal(made.preparedOnly,true);assert.equal(manifest.actualWindowsExecution,false);assert.equal(manifest.helperSha256,'3d2206f3b12e3e26406e60c9b11b7400e89d7cd3373e3b569e3331e4f5f7ce58');assert.equal(manifest.measurement.ownedTreeRssMaximumBytes,1610612736)
  for(const path of ['scripts/windows-soak-process-collector.mjs','tests/fixtures/windows-soak-process-collector.cs'])assert(manifest.files.some(f=>f.path===path))
  const entryResult=await execute(process.execPath,[made.run,'smoke'],{timeout:30000});assert.equal(JSON.parse(entryResult.stdout).status,'prepared-not-run')
  const path=join(output,'frozen/scripts/windows-soak-process-collector.mjs');await writeFile(path,(await readFile(path,'utf8'))+'\n// tamper\n')
  const rejected=await execute(process.execPath,[made.run,'smoke','--run','--root-approved'],{timeout:10000}).catch(error=>error);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/Frozen source changed/)
 }finally{await rm(parent,{recursive:true,force:true})}
})
