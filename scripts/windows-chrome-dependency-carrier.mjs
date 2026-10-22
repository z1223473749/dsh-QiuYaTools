import assert from 'node:assert/strict'
import {execFile}from'node:child_process'
import {promisify}from'node:util'
import{createHash}from'node:crypto'
import{readFile,writeFile,mkdir,appendFile,stat}from'node:fs/promises'
import{createReadStream}from'node:fs'
import{join,dirname}from'node:path'
import{fileURLToPath}from'node:url'
import{createServer}from'node:http'
import{createPowerShellTransport}from'./windows-browser-transport.mjs'
import{prepareBrowserVm}from'./windows-browser-evidence.mjs'
import{assessChromeDependency}from'./windows-chrome-dependency-evidence.mjs'
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),execute=promisify(execFile)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),quote=value=>`'${value.replaceAll("'","''")}'`,parse=value=>JSON.parse(value.replace(/^\uFEFF/u,''))
async function fileHash(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex')}
async function verify(){assert.equal(hash(await readFile(data.downloadReceipt)),data.downloadReceiptSHA256,'Download receipt changed');assert.equal(await fileHash(data.msi),data.msiSHA256,'MSI changed');assert.equal((await stat(data.msi)).size,data.msiBytes,'MSI size changed');for(const[path,digest]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(join(data.repository,path))),digest,'Bound source changed: '+path);for(const[path,digest]of Object.entries(data.frozenHashes))assert.equal(hash(await readFile(join(base,path))),digest,'Frozen installer carrier changed: '+path);assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256,'Entry changed')}
await verify()
if(process.argv.includes('--plan')){console.log(JSON.stringify({...data,actualWindowsExecution:false,downloadedOfficialMsi:true,signatureVerifiedOnWindows:false,installed:false,pdCommandsExecuted:0},null,2));process.exit(0)}
assert.ok(process.argv.includes('--run')&&process.argv.includes('--root-approved'),'Root must explicitly own the PD dependency installation slot')
await mkdir(data.output,{recursive:false})
const files=new Map([['install.ps1',await readFile(join(base,'snapshot/install.ps1'))]])
const requests=[],transports=[],cleanup={processSignalSent:false,taskStopSent:false,errors:[]}
let server,listening=false,identity,guestRoot,previousIdle,vmPreflight,report,execution,failure,sourceUnchanged=false,restored=false
const safe=error=>String(error.message).split('\n')[0].replace(/ -EncodedCommand .*/u,' [command omitted]').slice(0,500)
server=createServer((req,res)=>{const key=req.url?.startsWith('/'+data.id+'/')?req.url.slice(data.id.length+2):null;if(req.method!=='GET'||!key)return res.writeHead(404).end();if(key==='Chrome.msi'){requests.push({name:key,bytes:data.msiBytes});res.writeHead(200,{'content-length':data.msiBytes,'content-type':'application/x-msi'});const stream=createReadStream(data.msi);stream.on('error',()=>res.destroy());stream.pipe(res);return}const bytes=files.get(key);if(!bytes)return res.writeHead(404).end();res.writeHead(200,{'content-length':bytes.length}).end(bytes)})
const ps=createPowerShellTransport({files,url:name=>`http://${data.host}:${server.address().port}/${data.id}/${name}`,invoke:async(args,options)=>(await execute(data.prl,['exec',data.vm,'powershell.exe',...args],{...options,killSignal:'SIGKILL'})).stdout.trim(),receipt:async value=>{transports.push(value);await appendFile(join(data.output,'transport.jsonl'),JSON.stringify(value)+'\n')}})
try{
 await prepareBrowserVm(args=>execute(data.prl,args,{timeout:30000}),data.vm,value=>{vmPreflight=value;previousIdle=value.originalPauseIdle})
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,data.host,yes)});listening=true
 identity=parse(await ps(`$ErrorActionPreference='Stop';$u=@(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -ExpandProperty UserName -Unique);if($u.Count-ne 1){throw 'Interactive user ambiguous'};$s=([Security.Principal.NTAccount]::new($u[0])).Translate([Security.Principal.SecurityIdentifier]).Value;$p=(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s)).ProfileImagePath;@{sid=$s;profile=$p;programFiles=$env:PROGRAMFILES;windows=$env:WINDIR}|ConvertTo-Json -Compress`))
 assert.match(identity.sid,/^S-1-5-21-[0-9-]+$/u);assert.match(identity.profile,/^C:\\Users\\[^\\]+$/u)
 guestRoot=identity.profile+'\\AppData\\Local\\Temp\\QiuYaTools-chrome-dependency-'+data.id
 await ps(`$ErrorActionPreference='Stop';if(Test-Path -LiteralPath ${quote(guestRoot)}){throw 'Own scope already exists'};[void][IO.Directory]::CreateDirectory(${quote(guestRoot)})`)
 for(const[name,digest]of [['install.ps1',data.frozenHashes['snapshot/install.ps1']],['Chrome.msi',data.msiSHA256]])await ps(`$ErrorActionPreference='Stop';$w=[Net.WebClient]::new();$w.Proxy=$null;try{$w.DownloadFile(${quote(`http://${data.host}:${server.address().port}/${data.id}/${name}`)},${quote(guestRoot+'\\'+name)})}finally{$w.Dispose()};if((Get-FileHash -LiteralPath ${quote(guestRoot+'\\'+name)} -Algorithm SHA256).Hash.ToLowerInvariant()-cne '${digest}'){throw 'Own dependency transfer SHA mismatch'}`,180000)
 const ast=parse(await ps(`$ErrorActionPreference='Stop';$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${quote(guestRoot+'\\install.ps1')},[ref]$tokens,[ref]$errors);@{passed=(@($errors).Count-eq 0);errors=@($errors|ForEach-Object{$_.ErrorId})}|ConvertTo-Json -Depth 4 -Compress`));await writeFile(join(data.output,'ast.json'),JSON.stringify(ast,null,2));assert.equal(ast.passed,true,'Windows installer fixture AST rejected')
 await writeFile(join(data.output,'binding.json'),JSON.stringify({...data,identity,guestRoot,vmPreflight},null,2))
 execution=await ps(`$ErrorActionPreference='Stop';& ${quote(guestRoot+'\\install.ps1')} -OwnRoot ${quote(guestRoot)} -Msi ${quote(guestRoot+'\\Chrome.msi')} -ExpectedSha256 '${data.msiSHA256}' -InteractiveSid ${quote(identity.sid)};if($LASTEXITCODE-ne 0){throw 'Owned dependency fixture did not pass'}` ,300000)
}catch(error){failure=safe(error)}finally{
 if(guestRoot)for(const name of ['report.json','installer-start-receipt.json','install.log'])try{
  const path=guestRoot+'\\evidence\\'+name,index=parse(await ps(`$p=${quote(path)};if(Test-Path -LiteralPath $p){$f=Get-Item -LiteralPath $p;@{exists=$true;bytes=$f.Length;sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress}else{'{"exists":false}'}`))
  if(!index.exists){if(name==='report.json'||name==='installer-start-receipt.json')cleanup.errors.push('Dependency install evidence missing: '+name);continue}
  assert.ok(index.bytes<=32*1024*1024,'Dependency evidence exceeds bound')
  const bytes=Buffer.from(await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(path)}))`,60000,48*1024*1024),'base64');assert.equal(bytes.length,index.bytes);assert.equal(hash(bytes),index.sha256)
  await writeFile(join(data.output,name),bytes);if(name==='report.json')report=parse(bytes.toString('utf8'))
 }catch(error){cleanup.errors.push(safe(error))}
 if(listening){server.closeAllConnections();await new Promise(done=>server.close(done))}
 if(previousIdle)try{await execute(data.prl,['set',data.vm,'--pause-idle',previousIdle],{timeout:30000});restored=(await execute(data.prl,['list','--info',data.vm],{timeout:30000})).stdout.includes('Pause idle: '+previousIdle);assert.equal(restored,true)}catch(error){cleanup.errors.push(safe(error))}
 try{await verify();sourceUnchanged=true}catch(error){cleanup.errors.push(safe(error))}
 const behavior=assessChromeDependency(report,{msiSHA256:data.msiSHA256,msiBytes:data.msiBytes,interactiveSid:identity?.sid,expectedExecutable:(identity?.programFiles??'C:\\Program Files')+'\\Google\\Chrome\\Application\\chrome.exe',expectedInstaller:(identity?.windows??'C:\\Windows')+'\\System32\\msiexec.exe'})
 const verdict={passed:!failure&&cleanup.errors.length===0&&restored&&sourceUnchanged&&behavior.passed&&!transports.some(value=>value.cleanupVerified===false),output:data.output,actualWindowsExecution:Boolean(report),installed:behavior.installedNew&&behavior.validExe,behavior,failure:failure??null,vmPreflight:vmPreflight??null,originalPauseIdle:previousIdle??null,pauseIdleRestored:restored,sourceUnchanged,cleanup,requests,execution:execution??null}
 await writeFile(join(data.output,'delivery-verdict.json'),JSON.stringify(verdict,null,2));console.log(JSON.stringify(verdict,null,2));if(!verdict.passed)process.exitCode=1
}
