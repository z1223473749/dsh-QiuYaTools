import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPowerShellTransport } from './windows-browser-transport.mjs'
import { assessBrowserDelivery, prepareBrowserVm } from './windows-browser-evidence.mjs'
const root=dirname(fileURLToPath(import.meta.url)), exec=promisify(execFile)
const data=parseManifest(await readFile(join(root,'prepare-data.json'),'utf8'))
function parseManifest(value){return JSON.parse(value)}
const {vm,host,prl,id,output,browser,sourceHashes,expected,paths,cachedNode,cachedNodeSHA256}=data
const quote=s=>`'${s.replaceAll("'","''")}'`, sha=b=>createHash('sha256').update(b).digest('hex'), parse=s=>JSON.parse(s.replace(/^\uFEFF/u,'')), sleep=ms=>new Promise(r=>setTimeout(r,ms))
if(sha(await readFile(fileURLToPath(import.meta.url)))!==data.entrySHA256)throw Error('Frozen entry changed')
for(const [name,digest] of Object.entries(sourceHashes))if(sha(await readFile(join(data.repository,name)))!==digest)throw Error('Bound source changed: '+name)
for(const [name,digest] of Object.entries(data.carrierHashes))if(sha(await readFile(join(root,name)))!==digest)throw Error('Frozen carrier dependency changed: '+name)
const requested=process.argv.indexOf('--browser');if(requested>=0&&process.argv[requested+1]!==browser)throw Error('Browser selection is immutable; prepare a fresh entry for another browser')
const files=new Map()
for(const [name,path] of Object.entries(paths)){const b=await readFile(join(root,path));if(expected[name]&&sha(b)!==expected[name])throw Error('Frozen helper changed: '+name);files.set(name,b)}
if(process.argv.includes('--plan')){console.log(JSON.stringify({id,output,browser,expected,paths,cachedNodeSHA256,requiresRootScheduling:true,executed:false,wouldUseActualBrowser:true,actualOsDesktopInput:false,realModelInference:false,expectedChecks:browser==='all'?{chrome:10,edge:10}:{[browser]:10},snapshotImportSmoke:data.snapshotImportSmoke,sourceCount:Object.keys(sourceHashes).length},null,2));process.exit(0)}
if(!process.argv.includes('--run')||!process.argv.includes('--root-approved'))throw Error('Use --plan or --run --root-approved only when root assigns PD CLI slot')
await mkdir(output,{recursive:false})
const server=createServer((req,res)=>{const name=req.url?.startsWith('/'+id+'/')?req.url.slice(id.length+2):null,b=req.method==='GET'&&name&&files.get(name);if(!b)return res.writeHead(404).end();res.writeHead(200,{'content-length':b.length}).end(b)})
let listening=false,previousIdle,guestRoot,taskName,taskArguments,identity,naturalTaskExit,report,runError,vmPreflight
const cleanup={unregistered:false,stopSent:false,processSignalSent:false,errors:[]}, collection=[],transports=[]
const safe=e=>String(e.message).split('\n')[0].replace(/ -EncodedCommand .*/u,' [command omitted]').slice(0,400)
const powershell=createPowerShellTransport({files,url:name=>`http://${host}:${server.address().port}/${id}/${name}`,invoke:async(args,options)=>(await exec(prl,['exec',vm,'powershell.exe',...args],{...options,killSignal:'SIGKILL'})).stdout.trim(),receipt:async r=>{transports.push(r);await appendFile(join(output,'transport.jsonl'),JSON.stringify(r)+'\n')}})
async function state(){return parse(await powershell(`$ErrorActionPreference='Stop';$t=@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName -ceq ${quote(taskName)}});if($t.Count-ne 1){throw 'Owned task missing or ambiguous'};$a=@($t[0].Actions);if($a.Count-ne 1-or $a[0].Execute-ine 'powershell.exe'-or $a[0].Arguments-cne ${quote(taskArguments)}){throw 'Owned task command changed'};$u=$t[0].Principal.UserId;if($u-notmatch '^S-1-'){$u=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value};if($u-cne ${quote(identity.sid)}){throw 'Owned principal changed'};$i=Get-ScheduledTaskInfo -TaskName ${quote(taskName)};@{state=$t[0].State.ToString();result=[long]$i.LastTaskResult;identityMatched=$true}|ConvertTo-Json -Compress`))}
try{
 await prepareBrowserVm(args=>exec(prl,args,{timeout:30000}),vm,state=>{vmPreflight=state;previousIdle=state.originalPauseIdle})
 await new Promise((r,j)=>{server.once('error',j);server.listen(0,host,r)});listening=true
 identity=parse(await powershell(`$ErrorActionPreference='Stop';$u=(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName;if(!$u){throw 'No interactive user'};$s=([Security.Principal.NTAccount]::new($u)).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{user=$u;sid=$s;profile=$p}|ConvertTo-Json -Compress`))
 if(!identity.profile||!/^C:\\/iu.test(identity.profile))throw Error('Interactive profile unavailable')
 guestRoot=identity.profile+'\\AppData\\Local\\Temp\\QiuYaTools-browser-headless-'+id;taskName='QiuYaTools-browser-headless-'+id
 await powershell(`$ErrorActionPreference='Stop';if(Test-Path -LiteralPath ${quote(guestRoot)}){throw 'Own fresh path exists'};[void][IO.Directory]::CreateDirectory(${quote(guestRoot)})`)
 for(const [name,bytes]of files){await powershell(`$ErrorActionPreference='Stop';$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${id}/${name}`)},${quote(guestRoot+'\\'+name)});if((Get-FileHash -LiteralPath ${quote(guestRoot+'\\'+name)} -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${sha(bytes)}'){throw 'Transfer SHA mismatch'}`,90000);console.log(JSON.stringify({phase:'transferred',file:name,bytes:bytes.length}))}
 const ast=parse(await powershell(`$ErrorActionPreference='Stop';$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${quote(guestRoot+'\\run.ps1')},[ref]$t,[ref]$e);@{passed=(@($e).Count-eq 0);errors=@($e|ForEach-Object{$_.ErrorId})}|ConvertTo-Json -Depth 5 -Compress`));await writeFile(join(output,'ast.json'),JSON.stringify(ast,null,2));if(!ast.passed)throw Error('Guest parser rejected fixed self-test script')
 taskArguments=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${guestRoot}\\run.ps1" -Node "${cachedNode}" -Output "${guestRoot}\\evidence" -Browser ${browser}`
 await writeFile(join(output,'binding.json'),JSON.stringify({id,vm,host,guestRoot,taskName,taskArguments,expected,browser,scriptSha256:sha(files.get('run.ps1')),entrySha256:sha(await readFile(fileURLToPath(import.meta.url))),actualOsInput:false,actualDesktopCapture:false},null,2))
 await powershell(`$ErrorActionPreference='Stop';if(@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName -ceq ${quote(taskName)}}).Count){throw 'Fresh owned task exists'};$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(taskArguments)};$p=New-ScheduledTaskPrincipal -UserId ${quote(identity.user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(taskName)}`)
 console.log(JSON.stringify({phase:'headless-browser-regression-running-without-desktop-input',output}))
 for(let count=0;count<260;count++){const present=await powershell(`if(Test-Path -LiteralPath ${quote(guestRoot+'\\evidence\\report.json')}){'REPORT'}`);if(present==='REPORT')break;if(count===259)throw Error('Fixed self-test report polling deadline');await sleep(1500)}
 for(let count=0;count<20;count++){const s=await state();if(s.state==='Ready'){naturalTaskExit=s;break}await sleep(200)}
 if(!naturalTaskExit)throw Error('Owned runner did not exit naturally')
}catch(e){runError=safe(e)}finally{
 if(guestRoot){
  try{
   const names=["report.json", "chrome.stdout.txt", "chrome.stderr.txt", "edge.stdout.txt", "edge.stderr.txt", "chrome/launch-report.json", "edge/launch-report.json", "chrome/summary.json", "chrome/natural-closure.json", "chrome/owned-process-pins.json", "chrome/before.jpg", "chrome/after.jpg", "edge/summary.json", "edge/natural-closure.json", "edge/owned-process-pins.json", "edge/before.jpg", "edge/after.jpg"]
   for(const name of names){const index=parse(await powershell(`$p=${quote(guestRoot+'\\evidence\\'+name)};if(Test-Path -LiteralPath $p){$f=Get-Item -LiteralPath $p;@{exists=$true;bytes=$f.Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress}else{'{"exists":false}'}`));if(!index.exists)continue;if(index.bytes>1048576)throw Error('Owned report exceeds bound');const encoded=await powershell(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(guestRoot+'\\evidence\\'+name)}))`);const bytes=Buffer.from(encoded,'base64');if(bytes.length!==index.bytes||sha(bytes)!==index.sha256)throw Error('Evidence transfer SHA mismatch');await mkdir(dirname(join(output,name)),{recursive:true});await writeFile(join(output,name),bytes);collection.push({name,...index});if(name==='report.json')report=parse(bytes.toString('utf8'))}
  }catch(e){cleanup.errors.push(safe(e))}
 }
 if(taskName&&taskArguments&&identity){try{const s=await state();cleanup.taskBeforeRemoval=s;if(s.state==='Ready'){await powershell(`$ErrorActionPreference='Stop';Unregister-ScheduledTask -TaskName ${quote(taskName)} -TaskPath '\\' -Confirm:$false;if(@(Get-ScheduledTask -TaskPath '\\'|Where-Object{$_.TaskName -ceq ${quote(taskName)}}).Count){throw 'Owned task still registered'}`);cleanup.unregistered=true}else cleanup.errors.push('Owned task still running; no task stop or process signal sent')}catch(e){cleanup.errors.push(safe(e))}}
 if(listening){server.closeAllConnections();await new Promise(r=>server.close(r))}
 let pauseIdleRestored=false;try{if(previousIdle){await exec(prl,['set',vm,'--pause-idle',previousIdle],{timeout:30000});pauseIdleRestored=(await exec(prl,['list','--info',vm],{timeout:30000})).stdout.includes('Pause idle: '+previousIdle)}}catch(e){cleanup.errors.push(safe(e))}
 try{for(const [name,digest]of Object.entries(sourceHashes))if(sha(await readFile(join(data.repository,name)))!==digest)throw Error('Bound source changed during execution: '+name)}catch(e){cleanup.errors.push(safe(e))}
 const behavior=assessBrowserDelivery(report,browser)
 const verdict={passed:Boolean(behavior.passed&&naturalTaskExit?.state==='Ready'&&naturalTaskExit?.result===0&&cleanup.unregistered&&!cleanup.errors.length&&!runError&&pauseIdleRestored&&!transports.some(r=>r.cleanupVerified===false)),browser,behavior,output,vmPreflight:vmPreflight??null,actualWindowsExecution:Boolean(report),actualBrowser:Boolean(report?.checks?.some(row=>row.status==='passed'||row.status==='failed')),actualOsDesktopInput:false,realModelInference:false,naturalTaskExit:naturalTaskExit??null,cleanup,collection,originalPauseIdle:previousIdle??null,pauseIdleRestored,runError:runError??null}
 await writeFile(join(output,'delivery-verdict.json'),JSON.stringify(verdict,null,2));console.log(JSON.stringify(verdict,null,2));if(!verdict.passed)process.exitCode=1
}
