/** PD virtual hardware keyboard -> real Microsoft Pinyin -> isolated installed Harness/Edge editor. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run=promisify(execFile),vm=process.env.QIUYA_PD_VM,host=process.env.QIUYA_PD_HOST_IP
if(!vm||!/^[a-f0-9-]{36}$/iu.test(vm)||!host||!/^\d+\.\d+\.\d+\.\d+$/u.test(host))throw new Error('Set QIUYA_PD_VM and QIUYA_PD_HOST_IP for the selected authorized test VM')
const portable=process.env.QIUYA_WINDOWS_PORTABLE, node=process.env.QIUYA_WINDOWS_NODE,candidate=process.env.QIUYA_WINDOWS_GUEST_CANDIDATE
if(!portable||!node||!candidate)throw new Error('Set existing guest portable, Node and candidate paths from the isolated Windows Harness setup')
const output=resolve(process.env.QIUYA_WINDOWS_IME_OUTPUT||join(tmpdir(),`qiuya-windows-ime-${randomUUID()}`));await mkdir(output,{recursive:true})
const key=randomUUID(),guestOutput=`${portable}\\ime-${key}`,task=`QiuYaTools-ime-${key}`,prlctl=process.env.QIUYA_PRLCTL||'/Applications/Parallels Desktop.app/Contents/MacOS/prlctl',quote=s=>`'${s.replaceAll("'","''")}'`,delay=ms=>new Promise(d=>setTimeout(d,ms))
async function ps(code,timeout=30000){return(await run(prlctl,['exec',vm,'powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{timeout,killSignal:'SIGKILL',maxBuffer:32*1024*1024})).stdout.trim()}
const files=new Map([['test.mjs',await readFile('scripts/test-harness-ime-windows.mjs')],['provider.mjs',await readFile('tests/fixtures/harness-e2e-provider.mjs')]])
const launch=`import{writeFile}from'node:fs/promises';import{dirname,join}from'node:path';const c=${JSON.stringify({node,portable,candidate,guestOutput})};process.env.PATH=dirname(c.node)+';'+join(c.portable,'node_modules','.bin')+';'+process.env.PATH;process.env.npm_config_cache=join(c.guestOutput,'npm-cache');process.env.PNPM_HOME=join(c.guestOutput,'pnpm-home');process.argv=[c.node,join(c.portable,'scripts','test-harness-ime-windows.mjs'),'--package',c.candidate,'--output',c.guestOutput,'--cli-json',JSON.stringify([c.node,join(c.portable,'node_modules','@deepseek-ai','dsh','lib','bin.js')])];try{await import(new URL('./test-harness-ime-windows.mjs',import.meta.url).href)}catch(error){await writeFile(join(c.guestOutput,'startup-error.json'),JSON.stringify({error:error.message,stack:error.stack}));process.exitCode=1}finally{await writeFile(join(c.guestOutput,'completed.json'),JSON.stringify({exitCode:process.exitCode||0}))}`
files.set('launch.mjs',Buffer.from(launch));const server=createServer((req,res)=>{const parts=req.url.split('/'),file=parts[1]===key&&files.get(parts[2]);if(!file){res.writeHead(404).end();return}res.writeHead(200,{'Content-Length':file.length});res.end(file)});await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,host,done)})
const hardware=[],typed=new Set(),finished=new Set(),cleaned=new Set();let toggledMode=false,started=false
async function jsonFile(name){const value=await ps(`if(Test-Path ${quote(guestOutput+'\\'+name)}){[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(guestOutput+'\\'+name)}))}`);if(!value)return;try{return JSON.parse(Buffer.from(value,'base64').toString('utf8').replace(/^\uFEFF/u,''))}catch{return}}
async function mark(name){await ps(`[IO.File]::WriteAllText(${quote(guestOutput+'\\'+name)},'go')`)}
async function keyEvent(scancode,event){const args=['send-key-event',vm,'--scancode',String(scancode),'--delay','40',...(event?['--event',event]:[])];await run(prlctl,args,{timeout:10000,killSignal:'SIGKILL'});hardware.push({scancode,event:event||'press+release',at:new Date().toISOString()})}
async function ctrlKey(scan){await keyEvent(29,'press');try{await keyEvent(scan)}finally{await keyEvent(29,'release')}}
async function nihao(){for(const scan of[49,23,35,30,24])await keyEvent(scan)}
try{
 await ps(`New-Item -ItemType Directory -Force ${quote(guestOutput)}|Out-Null`)
 for(const[name,destination]of[['test.mjs','scripts\\test-harness-ime-windows.mjs'],['provider.mjs','tests\\fixtures\\harness-e2e-provider.mjs'],['launch.mjs','scripts\\launch-ime.mjs']])await ps(`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${key}/${name}`)},${quote(portable+'\\'+destination)})`)
 const user=await ps(`(Get-Process explorer -IncludeUserName|Where-Object SessionId -gt 0|Select-Object -First 1).UserName`)
 const launcher=`$p=Start-Process -FilePath ${quote(node)} -ArgumentList ${quote('"'+portable+'\\scripts\\launch-ime.mjs"')} -WorkingDirectory ${quote(portable)} -RedirectStandardOutput ${quote(guestOutput+'\\runner.log')} -RedirectStandardError ${quote(guestOutput+'\\runner.err')} -PassThru;$p.WaitForExit()`
 files.set('start.ps1',Buffer.from(launcher));await ps(`$c=[Net.WebClient]::new();$c.Proxy=$null;$c.DownloadFile(${quote(`http://${host}:${server.address().port}/${key}/start.ps1`)},${quote(guestOutput+'\\start.ps1')})`)
 await ps(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+guestOutput+'\\start.ps1"')};$p=New-ScheduledTaskPrincipal -UserId ${quote(user)} -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15);Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${quote(task)}`);started=true
 console.error('[qiuya-ime] isolated headed Windows Harness starting; HID waits for focused-editor checkpoints')
 let complete=false
 for(let i=0;i<600;i++){
  if(await jsonFile('completed.json')){complete=true;break}
  const checkpoint=await jsonFile('ime-checkpoint.json')
  if(checkpoint?.stage==='type-nihao'&&!typed.has(checkpoint.id)){
   assert.equal(checkpoint.focused,true);const state=await jsonFile(`ime-observation-${checkpoint.id}.json`);if(!state?.focused){await delay(150);continue}
   typed.add(checkpoint.id);await nihao();await delay(250)
   let observation=await jsonFile(`ime-observation-${checkpoint.id}.json`)
   if(!observation?.active&&checkpoint.id==='space'&&observation?.focused&&observation.text.trim().toLowerCase()==='nihao'){
    await ctrlKey(30);await keyEvent(14);await keyEvent(42);toggledMode=true;await nihao();await delay(300);observation=await jsonFile(`ime-observation-${checkpoint.id}.json`)
   }
   if(!observation?.focused)throw new Error('The disposable editor lost focus before a hardware shortcut; stopped input')
   if(!observation?.active)throw new Error('Installed Microsoft Pinyin did not enter actual composition; no simulated composition is substituted')
   if(checkpoint.id==='space')await keyEvent(57);else if(checkpoint.id==='enter')await keyEvent(28);else if(checkpoint.id==='tab')await keyEvent(15);else if(checkpoint.id==='escape')await keyEvent(1);else if(checkpoint.id==='ctrl-enter')await ctrlKey(28);else throw new Error('Unknown IME fixture case')
   finished.add(checkpoint.id);await mark(`ime-finish-${checkpoint.id}`)
  }else if(checkpoint?.stage==='cleanup-escape'&&!cleaned.has(checkpoint.id)){
   const observation=await jsonFile(`ime-observation-${checkpoint.id}.json`);if(!observation?.focused)throw new Error('Disposable editor lost focus before cleanup; stopped hardware input')
   if(observation.active)await keyEvent(1);cleaned.add(checkpoint.id);await mark(`ime-clean-${checkpoint.id}`)
  }else if(checkpoint?.stage==='restore-mode'){
   if(toggledMode){if(!checkpoint.focused)throw new Error('IME mode changed but private editor lost focus; restoration requires attention');await keyEvent(1);await keyEvent(42);toggledMode=false};await mark('ime-mode-restored')
  }
  await delay(350)
 }
 if(!complete)throw new Error('Windows hardware IME test timed out')
 const names=JSON.parse(await ps(`@(Get-ChildItem ${quote(guestOutput)} -File|Select-Object -ExpandProperty Name)|ConvertTo-Json -Compress`));for(const name of names){assert.match(name,/^[a-zA-Z0-9_.-]+$/u);if(name==='start.ps1'||name==='completed.json')continue;const value=await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${quote(guestOutput+'\\'+name)}))`);await writeFile(join(output,name),Buffer.from(value,'base64'))}
 const report=JSON.parse(await readFile(join(output,'report.json'),'utf8'));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,output,guestOutput}));if(!report.passed)process.exitCode=1
}catch(error){if(toggledMode){const id=[...typed].at(-1),state=id&&await jsonFile(`ime-observation-${id}.json`).catch(()=>undefined);if(state?.focused){await keyEvent(1).catch(()=>{});await keyEvent(42).then(()=>toggledMode=false,()=>{})}};await writeFile(join(output,'orchestration-error.json'),JSON.stringify({error:error.message,stack:error.stack,guestOutput},null,2));console.error(JSON.stringify({error:error.message,output,guestOutput}));process.exitCode=1}
finally{
 await writeFile(join(output,'hardware-events.json'),JSON.stringify({source:'Parallels virtual hardware scan codes; no Unicode injection or DOM composition dispatch',hardware,typed:[...typed],finished:[...finished],cleaned:[...cleaned],modeRestorationComplete:!toggledMode},null,2))
 if(started)await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false -ErrorAction SilentlyContinue`).catch(()=>{});server.closeAllConnections();await new Promise(done=>server.close(done))
}
