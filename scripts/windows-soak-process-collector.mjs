/** Test-only read-only sampler; every executed collector is included in its own snapshot. */
import {execFile} from 'node:child_process'
import {readFile,lstat} from 'node:fs/promises'
import {createHash} from 'node:crypto'

const fields=['pid','parentPid','name','createdAtTicks','cimCreatedAtTicks','identityPrecision','executablePath','workingSetBytes','privateBytes','cpuSeconds','ownedFixture','ownedWebView'].sort()
const precision='native-100ns-verified-against-CIM-microseconds'
const pathKey=value=>typeof value==='string'?value.replaceAll('/','\\').toLowerCase():''
const stamp=value=>typeof value==='string'&&/^[1-9]\d{0,18}$/u.test(value)?BigInt(value):null
export function validateCollectorRows(stdout,{pid,parentPid,path}){
 if(typeof stdout!=='string'||Buffer.byteLength(stdout)>8*1024*1024)throw Error('Collector output budget exceeded')
 let rows;try{rows=JSON.parse(stdout)}catch{throw Error('Malformed collector JSON')}
 if(!Array.isArray(rows)||rows.length===0||rows.length>4096)throw Error('Invalid collector rows')
 const seen=new Set()
 for(const row of rows){
  if(!row||Object.keys(row).sort().join('|')!==fields.join('|')||!Number.isSafeInteger(row.pid)||row.pid<0||seen.has(row.pid)||!Number.isSafeInteger(row.parentPid)||row.parentPid<0||typeof row.name!=='string'||!row.name||row.name.length>32768||!(row.executablePath===null||typeof row.executablePath==='string'&&row.executablePath.length<=32768)||!['workingSetBytes','privateBytes'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0)||!Number.isFinite(row.cpuSeconds)||row.cpuSeconds<0||typeof row.ownedFixture!=='boolean'||typeof row.ownedWebView!=='boolean')throw Error('Invalid collector schema')
  seen.add(row.pid)
  const cim=stamp(row.cimCreatedAtTicks),native=stamp(row.createdAtTicks)
  if(cim===null||cim%10n!==0n||!(row.identityPrecision===precision&&native!==null&&native-native%10n===cim||row.identityPrecision==='unavailable'&&row.createdAtTicks===null))throw Error('Unverified collector row identity')
 }
 const self=rows.find(row=>row.pid===pid)
 if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(parentPid)||!self||self.parentPid!==parentPid||self.identityPrecision!==precision||!pathKey(path)||pathKey(self.executablePath)!==pathKey(path))throw Error('Collector self identity missing or changed')
 return rows
}
export function invokeReadOnlyCollector(file,args,options){
 return new Promise((resolve,reject)=>{
  let child
  child=execFile(file,args,options,(error,stdout,stderr)=>{
   if(error){error.collectorExit={pid:child.pid??null,code:error.code??null,signal:error.signal??null,killed:error.killed===true};reject(error);return}
   resolve({stdout,stderr,pid:child.pid,code:child.exitCode,signal:child.signalCode,killed:child.killed})
  })
 })
}
export async function collectWindowsProcesses({file,sha256,nativeData,fixturePath,parentPid=process.pid,invoke=invokeReadOnlyCollector,audit=[],filesystem={lstat,readFile}}){
 if(typeof file!=='string'||!/^[a-z]:[\\/]/iu.test(file)||!/^([a-f0-9]{64})$/u.test(sha256??'')||typeof nativeData!=='string'||!nativeData||typeof fixturePath!=='string'||!fixturePath)throw Error('Invalid collector binding')
 const info=await filesystem.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('Invalid collector file')
 if(createHash('sha256').update(await filesystem.readFile(file)).digest('hex')!==sha256)throw Error('Collector executable SHA changed')
 const started=Date.now(),record={sha256,startedAt:new Date(started).toISOString(),timeoutMs:20000,maxBufferBytes:8*1024*1024,naturalExit:false};audit.push(record)
 try{
  const result=await invoke(file,[nativeData,fixturePath],{timeout:20000,maxBuffer:8*1024*1024,windowsHide:true,encoding:'utf8'})
  Object.assign(record,{pid:result.pid,code:result.code,signal:result.signal??null,killed:result.killed===true,elapsedMs:Date.now()-started})
  if(result.code!==0||result.signal||result.killed||result.stderr?.trim())throw Error('Collector did not exit normally')
  const rows=validateCollectorRows(result.stdout,{pid:result.pid,parentPid,path:file})
  record.naturalExit=true;record.rows=rows.length;record.selfIncluded=true
  return rows
 }catch(error){Object.assign(record,{elapsedMs:Date.now()-started,error:error.collectorExit?'Collector execution failed':error.message,...error.collectorExit});throw error}
}

export function collectorCompileCommand({source,output,sourceSha256}){
 if(![source,output].every(value=>typeof value==='string'&&/^[a-z]:[\\/]/iu.test(value))||!/^([a-f0-9]{64})$/u.test(sourceSha256??''))throw Error('Invalid collector compile binding')
 const q=value=>`'${value.replaceAll("'","''")}'`
 return `$ErrorActionPreference='Stop';$source=${q(source)};$out=${q(output)};if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()-cne ${q(sourceSha256)}){throw 'Collector source SHA changed'};if(Test-Path -LiteralPath $out){throw 'Collector output already exists'};Add-Type -Path $source -OutputAssembly $out -OutputType ConsoleApplication -ReferencedAssemblies 'System.dll','System.Core.dll','System.Management.dll','System.Web.Extensions.dll' -ErrorAction Stop;$item=Get-Item -LiteralPath $out;if($item.Attributes-band [IO.FileAttributes]::ReparsePoint){throw 'Collector executable reparse point'};@{sourceSha256=${q(sourceSha256)};sha256=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$item.Length;compiledBeforeMeasurement=$true}|ConvertTo-Json -Compress`
}

/** Finite diagnostics only. Never changes the runner's original status or budgets. */
export function finiteSoakGateEvidence(report,expectedFaults){
 const limits=report.resourceBounds?.limits
 const gates={uniqueFps:report.uniqueFps>=10,wallFps:report.endToEndFps>=10,latency:Number.isFinite(report.latencyP95Ms)&&report.latencyP95Ms<=500,validClocks:report.invalidTimestamps===0,dimensions:report.wrongDimensions===0,faults:report.faults?.length===expectedFaults,generations:report.generations?.length===expectedFaults+1&&report.generations.every(row=>row.frames>0),attachments:report.attachmentWrites===0,resources:report.resourcesBounded===true,cleanup:report.cleanup?.passed===true}
 const samples=(report.resources??[]).map(row=>{
  const roles={node:0,native:0,webview:0,collector:0,powershell:0,console:0,other:0}
  for(const item of row.processes??[]){const name=item.name?.toLowerCase()??'',role=name==='node.exe'?'node':name==='qiuya-windows.exe'?'native':name==='msedgewebview2.exe'?'webview':name==='windows-soak-process-collector.exe'?'collector':name==='powershell.exe'?'powershell':name==='conhost.exe'?'console':'other';roles[role]+=item.workingSetBytes}
  return {elapsedMs:row.elapsedMs,totalRssBytes:Object.values(roles).reduce((sum,value)=>sum+value,0),roles}
 })
 return {failedGates:Object.entries(gates).filter(([,passed])=>!passed).map(([key])=>key),gates,limits,samples}
}
