/** Mac-only, immutable headless DOM scope. Never starts tests during prepare. */
import assert from 'node:assert/strict'
import{readFile,writeFile,mkdir,realpath}from'node:fs/promises'
import{join,dirname,resolve}from'node:path'
import{fileURLToPath,pathToFileURL}from'node:url'
import{createHash,randomUUID}from'node:crypto'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
import{build}from'esbuild'
export const DOM_HARNESS_CASES=Object.freeze(['account-menu-settings-and-all-feature-tabs','settings-persist-thresholds-and-theme','real-local-model-session','prompt-suggestion-tab-and-escape','paste-browser-event-to-official-txt-upload','session-menus-copy-unread-and-pin','batch-archive-real-sessions','plan-review-comment-and-draft-preservation'])
export const DOM_HARNESS_EXCLUDED=Object.freeze(['native-independent-window-and-reuse','trusted-browser-drag-to-native-window','computer-main-agent-tools-and-image-adapter-pipeline','packaged-file-exchange-real-host-upload-download-and-no-overwrite'])
export function makeDomHarnessSource(source,{repository,providerSource}){
 const once=(before,after)=>{assert.equal(source.split(before).length,2,'Unique snapshot patch anchor required: '+before.slice(0,80));source=source.replace(before,after)}
 once("const root = fileURLToPath(new URL('../', import.meta.url))",'const root = '+JSON.stringify(repository))
 source=source.replace(/^const featureEvidenceOnly = .*$/mu,'const featureEvidenceOnly = true').replace(/^const pastedTextOnly = .*$/mu,'const pastedTextOnly = false').replace(/^const featureEvidenceCases = .*$/mu,'const featureEvidenceCases = new Set('+JSON.stringify(DOM_HARNESS_CASES)+')')
 const begin=source.indexOf('const nativeCommand = '),end=source.indexOf('async function ownMacTarget(',begin)
 assert.ok(begin>0&&end>begin,'Expected native-command scope')
 source=source.slice(0,begin)+"let forbiddenNativeCommandCalls = 0\nconst nativeCommand = async () => { forbiddenNativeCommandCalls++; throw new Error('Native commands are excluded from this headless DOM scope') }\n"+source.slice(end)
 once("entryPoints: [join(root, 'tests/fixtures/harness-e2e-provider.mjs')]",'entryPoints: ['+JSON.stringify(providerSource)+']')
 once("headless: !process.argv.includes('--headed')",'headless: true')
 once("assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4')", "assert.equal(await page.getByRole('spinbutton').nth(1).inputValue(), '4'); await screenshot('thresholds-saved')")
 once("assert.equal(await ghost.innerText(), '继续检查本地测试结果。')", "assert.equal(await ghost.innerText(), '继续检查本地测试结果。'); await screenshot('prompt-suggestion')")
 once("await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。')", "await editor().press('Tab'); assert.equal(await editor().innerText(), '继续检查本地测试结果。'); await screenshot('prompt-accepted')")
 once("await menu(alpha); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()", "await menu(alpha); await screenshot('session-menu-copy'); await page.getByRole('menuitem', { name: '复制会话标题', exact: true }).click()")
 once("await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor()", "await row(alpha).locator('[data-qyt-manual-unread=\"true\"]').waitFor(); await screenshot('session-menu-unread')")
 once("await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await page.keyboard.press('Escape')", "await menu(alpha); await page.getByRole('menuitem', { name: '取消置顶', exact: false }).waitFor(); await screenshot('session-menu-pin'); await page.keyboard.press('Escape')")

 once("'official-Harness-feature-evidence-subset'","'official-Harness-Mac-headless-DOM-subset'")
 once("scope: pastedTextOnly ? 'strict-pasted-text-evidence' : 'strict-feature-evidence'","scope: 'headless-dom-only'")
 once('selectedCases: [...featureEvidenceCases], fullUIAcceptance: false','selectedCases: [...featureEvidenceCases], excludedCases: '+JSON.stringify(DOM_HARNESS_EXCLUDED)+', fullUIAcceptance: false, nativeUIAcceptance: false')
 once("else if (host) await Promise.race([new Promise(resolve => host.once('exit', resolve)), sleep(3000).then(() => host.kill('SIGKILL'))])",`else if (host) await new Promise(resolve => {
    if (host.exitCode !== null || host.signalCode !== null) return resolve()
    const timer = setTimeout(() => { errors.push('Owned DOM Host did not retire after its normal SIGTERM shutdown'); resolve() }, 5000)
    host.once('exit', () => { clearTimeout(timer); resolve() })
  })`)
 once("model: 'deterministic local fixture, no real account credentials'", "headlessOnlyEvidence: { browserHeadless: true, domProtocolOnly: true, nativeCommandCalls: forbiddenNativeCommandCalls, nativeDriverStarted: Boolean(driver), nativeFixtureCompiled: Boolean(macTargetFixture), hostPid: host?.pid ?? null, hostRetired: Boolean(host && (host.exitCode !== null || host.signalCode !== null)), hostExitCode: host?.exitCode ?? null, hostSignal: host?.signalCode ?? null, browserCloseSucceeded: Boolean(browser && !ownedCleanupErrors.some(row => row.stage === 'browser-close')) }, model: 'deterministic local fixture, no real account credentials'")
 once('The local adapter proves actual main-Agent tool/image transport. External vision-model reasoning and physical IME composition require separate evidence.','This headless DOM subset excludes native windows, desktop drag, computer input, real vision inference and physical IME; its model provider is deterministic.')
 return source
}
export function assessDomHarnessReport(report){
 const rows=report?.tests??[],names=rows.map(row=>row.name),headless=report?.headlessOnlyEvidence
 const exactSelection=rows.length===DOM_HARNESS_CASES.length&&DOM_HARNESS_CASES.every((name,index)=>names[index]===name)&&rows.every(row=>row.status==='passed')
 const pages=rows.find(row=>row.name===DOM_HARNESS_CASES[0])?.details?.pages
 const nativeExcluded=report?.selection?.fullUIAcceptance===false&&report?.selection?.nativeUIAcceptance===false&&JSON.stringify(report?.selection?.excludedCases)===JSON.stringify(DOM_HARNESS_EXCLUDED)
 const noNativeExecution=headless?.browserHeadless===true&&headless?.domProtocolOnly===true&&headless?.nativeCommandCalls===0&&headless?.nativeDriverStarted===false&&headless?.nativeFixtureCompiled===false
 const hostRetired=headless?.hostRetired===true&&headless?.hostExitCode===0&&headless?.hostSignal===null&&headless?.browserCloseSucceeded===true
 return{passed:Boolean(report?.status==='passed'&&report?.platform==='darwin'&&report?.kind==='official-Harness-Mac-headless-DOM-subset'&&report?.selection?.scope==='headless-dom-only'&&exactSelection&&Array.isArray(pages)&&pages.length===10&&nativeExcluded&&noNativeExecution&&hostRetired&&report?.ownedCleanup?.passed===true&&Array.isArray(report?.frontendErrors)&&report.frontendErrors.length===0),exactSelection,settingsPages:pages?.length??0,nativeExcluded,noNativeExecution,hostRetired}
}
async function prepare(){
 assert.equal(process.platform,'darwin','This scope is specifically a Mac DOM acceptance')
 const repository=fileURLToPath(new URL('../',import.meta.url)),execute=promisify(execFile),id=randomUUID(),base=join(repository,'artifacts/harness-e2e/macos-dom-prepared-'+id),snapshot=join(base,'snapshot'),hash=b=>createHash('sha256').update(b).digest('hex')
 const candidate=await realpath('/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz'),candidateSHA256=hash(await readFile(candidate));assert.equal(candidateSHA256,'9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3')
 const binary=(await execute('/usr/bin/tar',['-xOf',candidate,'package/lib/QiuYaTools Computer.app/Contents/MacOS/qiuya-computer'],{encoding:'buffer',maxBuffer:16*1024*1024})).stdout,helperSHA256=hash(binary);assert.equal(helperSHA256,'66ae37d056385e3053724a07a982993c9f8356481666b2d8ee59f65d1356e502')
 await mkdir(snapshot,{recursive:true})
 const graph=await build({entryPoints:[join(repository,'scripts/e2e-harness.mjs')],absWorkingDir:repository,bundle:true,packages:'external',write:false,platform:'node',format:'esm',metafile:true})
 const sourceHashes={},snapshotHashes={}
 for(const name of Object.keys(graph.metafile.inputs)){
  assert.ok(!name.startsWith('..')&&!name.startsWith('/'),'Snapshot dependency escaped repo')
  const original=await readFile(join(repository,name),'utf8');let bytes=Buffer.from(original)
  if(name==='scripts/e2e-harness.mjs')bytes=Buffer.from(makeDomHarnessSource(original,{repository,providerSource:join(snapshot,'tests/fixtures/harness-e2e-provider.mjs')}))
  await mkdir(dirname(join(snapshot,name)),{recursive:true});await writeFile(join(snapshot,name),bytes);sourceHashes[name]=hash(Buffer.from(original));snapshotHashes[name]=hash(bytes)
 }
 for(const name of ['scripts/prepare-harness-dom-acceptance.mjs','tests/harness-dom-acceptance.test.mjs','package.json','package-lock.json'])sourceHashes[name]=hash(await readFile(join(repository,name)))
 const closure=await build({entryPoints:[join(snapshot,'scripts/e2e-harness.mjs')],absWorkingDir:base,bundle:true,packages:'external',write:false,platform:'node',format:'esm',metafile:true})
 assert.ok(Object.keys(closure.metafile.inputs).some(name=>name.endsWith('snapshot/tests/fixtures/harness-e2e-provider.mjs')))
 const data={id,repository,preparedAt:new Date().toISOString(),sourceHashes,snapshotHashes,candidate,candidateSHA256,helperSHA256,selectedCases:DOM_HARNESS_CASES,excludedCases:DOM_HARNESS_EXCLUDED,output:'/Users/qiuya/QiuYaTools-验收/2026-10-22/原始截图/Mac-headless-DOM-8项-'+id,screenshots:'/Users/qiuya/QiuYaTools-验收/2026-10-22/成功截图/Mac-headless-DOM-8项-'+id,scope:'headless DOM and real isolated Harness Host; not native Mac acceptance',snapshotImportSmoke:{passed:true,inputs:Object.keys(closure.metafile.inputs),executed:false,guiStarted:false,pdCommandsExecuted:0}}
 const entry=String.raw`import assert from'node:assert/strict';import{readFile,writeFile,mkdir}from'node:fs/promises';import{join,dirname}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import{spawn}from'node:child_process';import{assessDomHarnessReport}from'./dom-policy.mjs';
const base=dirname(fileURLToPath(import.meta.url)),data=JSON.parse(await readFile(join(base,'prepare-data.json'),'utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
async function verify(){assert.equal(hash(await readFile(fileURLToPath(import.meta.url))),data.entrySHA256);assert.equal(hash(await readFile(data.candidate)),data.candidateSHA256);for(const[name,digest]of Object.entries(data.sourceHashes))assert.equal(hash(await readFile(join(data.repository,name))),digest,'Bound source changed: '+name);for(const[name,digest]of Object.entries(data.snapshotHashes))assert.equal(hash(await readFile(join(base,'snapshot',name))),digest,'Frozen dependency changed: '+name);assert.equal(hash(await readFile(join(base,'dom-policy.mjs'))),data.policySHA256)}
await verify();if(process.argv.includes('--plan')){console.log(JSON.stringify({...data,actualExecution:false,nativeInput:false,guiStarted:false,pdCommandsExecuted:0},null,2));process.exit(0)}
assert.ok(process.argv.includes('--run')&&process.argv.includes('--root-approved'),'Root must schedule this isolated headless Host run');assert.equal(process.platform,'darwin');await mkdir(data.output,{recursive:false});await mkdir(data.screenshots,{recursive:false});await writeFile(join(data.output,'carrier-binding.json'),JSON.stringify(data,null,2));
let stdout='',stderr='',exit,failure,stable=false,report;try{exit=await new Promise((done,reject)=>{const child=spawn(process.execPath,[join(base,'snapshot/scripts/e2e-harness.mjs'),'--package',data.candidate,'--output',data.output,'--screenshots-dir',data.screenshots,'--browser','chrome','--feature-evidence-only'],{cwd:data.repository,env:process.env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{stdout=(stdout+b).slice(-2*1024*1024)});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2*1024*1024)});child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}))});assert.deepEqual(exit,{code:0,signal:null});report=JSON.parse(await readFile(join(data.output,'report.json'),'utf8'));await verify();stable=true}catch(error){failure=error.message}finally{await writeFile(join(data.output,'carrier-stdout.log'),stdout);await writeFile(join(data.output,'carrier-stderr.log'),stderr);const behavior=assessDomHarnessReport(report);const verdict={passed:!failure&&stable&&behavior.passed,output:data.output,screenshots:data.screenshots,scope:data.scope,behavior,exit,failure:failure??null,sourceStable:stable,actualNativeInput:false,fullMacUIAcceptance:false};await writeFile(join(data.output,'carrier-verdict.json'),JSON.stringify(verdict,null,2));console.log(JSON.stringify(verdict,null,2));if(!verdict.passed)process.exitCode=1}
`
 await writeFile(join(base,'entry.mjs'),entry);const policy=await readFile(fileURLToPath(import.meta.url));await writeFile(join(base,'dom-policy.mjs'),policy);data.policySHA256=hash(policy);data.entrySHA256=hash(Buffer.from(entry));await writeFile(join(base,'prepare-data.json'),JSON.stringify(data,null,2))
 console.log(JSON.stringify({entry:join(base,'entry.mjs'),output:data.output,screenshots:data.screenshots,candidateSHA256,helperSHA256,selectedCases:DOM_HARNESS_CASES,excludedCases:DOM_HARNESS_EXCLUDED,sourceCount:Object.keys(sourceHashes).length,snapshotImportSmoke:data.snapshotImportSmoke,executed:false},null,2))
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await prepare()
