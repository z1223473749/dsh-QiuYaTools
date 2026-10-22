import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=dirname(fileURLToPath(import.meta.url)),arg=n=>{const i=process.argv.indexOf(n);return i<0?undefined:process.argv[i+1]}
const browser=arg('--browser'),executable=arg('--executable'),output=resolve(arg('--output')||'')
if(process.platform!=='win32'||!['chrome','edge'].includes(browser)||!executable||!arg('--output'))throw Error('Requires Windows, explicit installed browser executable and fresh own output')
const parse=s=>JSON.parse(s.replace(/^\uFEFF/u,'')),quote=s=>`'${s.replaceAll("'","''")}'`
const ps=code=>parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,maxBuffer:1048576}))
const {BrowserSession}=await import('./module.mjs'),{runBrowserSmoke}=await import('./smoke.mjs'),records=[],trees=[],diagnosticErrors=[]
const launch=BrowserSession.prototype.launch,close=BrowserSession.prototype.close
BrowserSession.prototype.launch=async function(...args){
 await launch.apply(this,args)
 const child=this.child;if(!child||records.some(r=>r.pid===child.pid))return
 const identity=ps(`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${child.pid});try{$null=$p.SafeHandle;@{pid=$p.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.MainModule.FileName;sessionId=$p.SessionId}|ConvertTo-Json -Compress}finally{$p.Dispose()}`)
 assert.equal(win32.normalize(identity.executable).toLowerCase(),win32.normalize(executable).toLowerCase())
 assert.ok(win32.normalize(this.profileDir).toLowerCase().startsWith(win32.normalize(process.env.TEMP).toLowerCase()+'\\'))
 const record={...identity,profile:this.profileDir,exitCode:child.exitCode,signalCode:child.signalCode,killCalls:[]};records.push(record)
 const kill=child.kill.bind(child);child.kill=(...values)=>{record.killCalls.push(values[0]??'SIGTERM');return kill(...values)}
 child.once('exit',(code,signal)=>{record.exitCode=code;record.signalCode=signal})
}
BrowserSession.prototype.close=async function(...args){
 const child=this.child,record=child&&records.find(r=>r.pid===child.pid)
 try{if(record&&child.exitCode===null&&child.signalCode===null){
  const tree=ps(`$ErrorActionPreference='Stop';$root=[Diagnostics.Process]::GetProcessById(${record.pid});try{$null=$root.SafeHandle;if($root.StartTime.ToUniversalTime().Ticks.ToString()-cne '${record.createdAtTicks}'){throw 'Owned browser birth changed'};$all=@(Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${record.pid});for($i=0;$i-lt 16;$i++){$before=$ids.Count;foreach($c in $all){if($ids.Contains([int]$c.ParentProcessId)){[void]$ids.Add([int]$c.ProcessId)}};if($ids.Count-eq $before){break};if($ids.Count-gt 128){throw 'Own browser subtree bound'}};$rows=@();foreach($id in $ids){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById($id);$null=$p.SafeHandle;$rows+=@{pid=$p.Id;createdAtTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.MainModule.FileName}}catch [ArgumentException]{}finally{if($p){$p.Dispose()}}};@{rootPid=${record.pid};rows=$rows}|ConvertTo-Json -Depth 6 -Compress}finally{$root.Dispose()}`)
  trees.push(tree)
 }}catch(e){diagnosticErrors.push(String(e.message).slice(0,600))}
 return close.apply(this,args)
}
let result,error,postflight
try{result=await runBrowserSmoke({browser,executable,artifacts:output,modulePath:join(root,'module.mjs')})}
catch(e){error=String(e.message).slice(0,600);process.exitCode=1}
finally{
 const pins=[...new Map(trees.flatMap(t=>t.rows).map(p=>[p.pid+':'+p.createdAtTicks,p])).values()]
 try{
  const json=JSON.stringify(pins),pinsFile=join(output,'owned-process-pins.json'),digest=createHash('sha256').update(json).digest('hex');await writeFile(pinsFile,json)
  postflight=ps(`$ErrorActionPreference='Stop';$path=${quote(pinsFile)};if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'Owned pin file changed'};$pins=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json;$left=@();foreach($pin in @($pins)){$p=$null;try{$p=[Diagnostics.Process]::GetProcessById([int]$pin.pid);$null=$p.SafeHandle;if($p.StartTime.ToUniversalTime().Ticks.ToString()-ceq $pin.createdAtTicks){$left+=@{pid=$pin.pid;createdAtTicks=$pin.createdAtTicks}}}catch [ArgumentException]{}finally{if($p){$p.Dispose()}}};@{remaining=$left;checked=@($pins).Count;passed=($left.Count-eq 0)}|ConvertTo-Json -Depth 5 -Compress`)
 }catch(e){error??=String(e.message).slice(0,600);process.exitCode=1}
 const passed=Boolean(result?.status==='passed'&&result?.checks?.length===10&&records.length===2&&records.every(r=>r.exitCode===0&&r.signalCode===null&&r.killCalls.length===0)&&postflight?.passed&&!error&&!diagnosticErrors.length)
 const receipt={passed,browser,actualOsDesktopInput:false,actualBrowser:true,registeredAgentCallbacks:true,realModelInference:false,result:result??null,ownedBrowserParents:records,ownedSubtrees:trees,diagnosticErrors,postflight:postflight??null,error:error??null}
 await writeFile(join(output,'natural-closure.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed,browser,checks:result?.checks?.length,ownedParents:records.length,remaining:postflight?.remaining,error:error??null}));if(!passed)process.exitCode=1
}
