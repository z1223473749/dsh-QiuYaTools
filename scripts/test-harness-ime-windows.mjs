/** Real Microsoft Pinyin in an installed isolated Harness. A PD hardware-key coordinator supplies input. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile,writeFile,mkdir,mkdtemp,copyFile,rm } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
if(process.platform!=='win32')throw new Error('This test requires actual Windows and an interactive Microsoft Pinyin context')
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]},output=resolve(arg('--output','artifacts/windows-ime')),candidate=resolve(arg('--package')),cli=JSON.parse(arg('--cli-json'))
assert.ok(Array.isArray(cli)&&cli.length&&cli.every(v=>typeof v==='string'))
const root=fileURLToPath(new URL('../',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'qiuya-harness-ime-')),profile=join(temporary,'qiuya-harness-home'),candidateSha256=createHash('sha256').update(await readFile(candidate)).digest('hex')
await mkdir(output,{recursive:true});const env={...process.env,DSH_HOME:profile,QIUYA_HARNESS_E2E:'1'},delay=ms=>new Promise(r=>setTimeout(r,ms)),checks=[]
let host,browser,page,report
const execute=(args,timeout=120000)=>new Promise((done,reject)=>{const child=spawn(cli[0],[...cli.slice(1),...args],{env,cwd:root,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const timer=setTimeout(()=>{child.kill();reject(new Error('Isolated CLI timeout'))},timeout);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?done(log):reject(new Error(log.replace(/([?&]token=)[^&\s]+/gu,'$1<redacted>').slice(-8000)))})})
async function until(operation,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await operation();if(value)return value;await delay(100)}throw new Error(message)}
async function marker(name){return readFile(join(output,name),'utf8').then(()=>true,()=>false)}
async function checkpoint(value){await writeFile(join(output,'ime-checkpoint.json'),JSON.stringify({...value,at:new Date().toISOString()}))}
const requests=async()=>readFile(join(profile,'e2e-adapter-requests.jsonl'),'utf8').then(s=>s.trim().split('\n').filter(Boolean).map(JSON.parse),()=>[])
const mainCalls=async()=>(await requests()).filter(row=>row.tools?.length>0).length
try{
 await execute(['--profile','web','--dump-config']);await execute(['plugin','--profile','web','add',candidate]);assert.equal(createHash('sha256').update(await readFile(candidate)).digest('hex'),candidateSha256,'Candidate archive changed during installation')
 const provider=join(temporary,'provider');await mkdir(provider);await copyFile(join(root,'tests/fixtures/harness-e2e-provider.mjs'),join(provider,'index.mjs'));await writeFile(join(provider,'package.json'),'{"name":"qiuya-ime-fixture","type":"module","version":"1.0.0"}')
 const overlay=join(temporary,'overlay.yml');await writeFile(overlay,JSON.stringify([{id:'agent-default-model',config:{provider:'qiuya-e2e',model:'fixture'}},{id:'session-title-llm',disabled:true},{id:'session-telemetry-otel',disabled:true},{insert:[{id:'qiuya-harness-e2e-provider',name:join(provider,'index.mjs')}]}]))
 host=spawn(cli[0],[...cli.slice(1),'--profile','web','--patch',overlay,'--no-open','--port','0'],{env,cwd:root,stdio:['pipe','pipe','pipe']});let startup='',exited=false;host.stdout.on('data',b=>startup+=b);host.stderr.on('data',b=>startup+=b);host.once('exit',()=>exited=true)
 const url=await until(()=>{if(exited)throw new Error('Isolated Host exited');return startup.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0]},'Isolated Host startup timeout',90000)
 await writeFile(join(output,'host-startup.log'),startup.replace(/([?&]token=)[^&\s]+/gu,'$1<redacted>'))
 browser=await chromium.launch({channel:'msedge',headless:false});const context=await browser.newContext({viewport:{width:1440,height:1000}})
 await context.route('**/*',route=>{const u=new URL(route.request().url());return['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname)?route.abort():route.continue()})
 page=await context.newPage();await page.goto(url);const onboarding=page.getByRole('button',{name:'继续',exact:true});await onboarding.waitFor({timeout:8000}).catch(()=>{});if(await onboarding.isVisible())await onboarding.click();await page.getByRole('button',{name:'账号菜单',exact:true}).waitFor()
 const editor=page.locator('[data-composer-input][contenteditable="true"]').first();await editor.fill('E2E:ime-hardware');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('已完成本地测试回复：E2E:ime-hardware',{exact:true}).waitFor({timeout:20000})
 await page.evaluate(()=>{window.__imeEvents=[];window.__imeActive=false;for(const type of['keydown','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend'])document.addEventListener(type,event=>{if(!event.target.closest?.('[data-composer-input]'))return;if(type==='compositionstart')window.__imeActive=true;if(type==='compositionend')window.__imeActive=false;window.__imeEvents.push({type,key:event.key,code:event.code,keyCode:event.keyCode,isComposing:event.isComposing,data:event.data,inputType:event.inputType,isTrusted:event.isTrusted,at:performance.now()})},true)})
 assert.ok(await mainCalls()>0,'The seeded real main-Agent request must be observable before checking accidental sends')
 const readState=()=>page.evaluate(()=>({active:window.__imeActive,events:window.__imeEvents,text:document.querySelector('[data-composer-input]')?.innerText||'',focused:document.hasFocus()&&!!document.activeElement?.closest?.('[data-composer-input]'),ghost:document.querySelector('.qyt-prompt-suggestion-text')?.textContent||''}))
 for(const [id,finish]of[['space','Space'],['enter','Enter'],['tab','Tab'],['escape','Escape'],['ctrl-enter','Ctrl+Enter']]){
  await editor.fill('x');await editor.fill('');await page.locator('.qyt-prompt-suggestion-text').first().waitFor({state:'visible',timeout:15000});await page.bringToFront();await editor.click();await delay(150);await page.evaluate(()=>{document.title='QiuYaTools IME Hardware Fixture';window.__imeEvents=[];window.__imeActive=false})
  const before=await mainCalls(),initial=await readState();if(!initial.focused)throw new Error('Disposable Edge editor did not own focus; no hardware keys may be sent')
  await checkpoint({id,stage:'type-nihao',finish,focused:initial.focused,ghost:initial.ghost,mainModelCalls:before})
  let sawComposition=false,lastActive
  await until(async()=>{const state=await readState();if(state.active&&state.events.some(e=>e.type==='compositionstart'&&e.isTrusted)){sawComposition=true;lastActive=state}await writeFile(join(output,`ime-observation-${id}.json`),JSON.stringify(state));return marker(`ime-finish-${id}`)},'Hardware IME case was not completed',60000)
  await delay(500);const after=await readState(),afterCalls=await mainCalls();const errors=[]
  if(!sawComposition)errors.push('No trusted live IME composition was observed')
  if(!after.events.some(e=>e.type==='compositionupdate'&&e.isTrusted))errors.push('No trusted compositionupdate')
  if(afterCalls!==before)errors.push('Composition shortcut submitted a new main-Agent request')
  if(after.text.includes('继续检查本地测试结果。'))errors.push('Prompt suggestion was incorrectly accepted during composition')
  // The installed Harness editor normalizes compositionend with an untrusted replacement event.
  // Prove real IME commit with the preceding trusted native update/input and resulting Chinese text.
  if(id==='space'&&(!/[\u3400-\u9fff]/u.test(after.text)||after.active||!after.events.some(e=>e.type==='compositionupdate'&&e.isTrusted&&/[\u3400-\u9fff]/u.test(e.data||''))||!after.events.some(e=>e.type==='input'&&e.isTrusted&&/[\u3400-\u9fff]/u.test(e.data||''))))errors.push('Space did not commit actual Chinese text through Microsoft Pinyin')
  if(id==='escape'&&after.text.trim()!=='')errors.push('Escape did not cancel the disposable composition')
  const result={id,finish,passed:errors.length===0,errors,beforeMainModelCalls:before,afterMainModelCalls:afterCalls,beforeFinish:lastActive,after};checks.push(result);await writeFile(join(output,`ime-events-${id}.json`),JSON.stringify(result,null,2));await page.screenshot({path:join(output,`ime-${id}.png`)})
  await checkpoint({id,stage:'cleanup-escape',passed:result.passed});await until(()=>marker(`ime-clean-${id}`),'Hardware cleanup Escape was not acknowledged',30000);await delay(100)
 }
 report={passed:checks.every(c=>c.passed),checks,candidateSha256,platform:process.platform,architecture:process.arch,actualIme:true,source:'Parallels virtual hardware scan codes into installed Microsoft Pinyin',profileIsolation:true,model:'deterministic local provider; no user credentials',limitations:['Only the preinstalled Microsoft Pinyin and current Windows ARM64/Edge versions are covered.']}
}catch(error){report={passed:false,checks,error:error.message,stack:error.stack,platform:process.platform,architecture:process.arch};await page?.screenshot({path:join(output,'failed.png')}).catch(()=>{})}
finally{if(page&&!page.isClosed()){const focused=await page.evaluate(()=>document.hasFocus()&&!!document.activeElement?.closest?.('[data-composer-input]')).catch(()=>false);await checkpoint({stage:'restore-mode',focused});await until(()=>marker('ime-mode-restored'),'Hardware IME mode restoration was not acknowledged',30000).catch(error=>{report.passed=false;report.restorationError=error.message})};await checkpoint({stage:'completed',passed:report?.passed});await browser?.close();host?.stdin.end();host?.kill();if(host)await Promise.race([new Promise(done=>host.once('exit',done)),delay(3000).then(()=>host.kill('SIGKILL'))]);await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true}).catch(()=>{});console.log(JSON.stringify({passed:report.passed,checks:checks.length,output,error:report.error}));if(!report.passed)process.exitCode=1}
