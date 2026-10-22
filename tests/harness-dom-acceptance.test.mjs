import test from'node:test'
import assert from'node:assert/strict'
import{readFile,access}from'node:fs/promises'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
import{fileURLToPath}from'node:url'
import{makeDomHarnessSource,assessDomHarnessReport,DOM_HARNESS_CASES,DOM_HARNESS_EXCLUDED}from'../scripts/prepare-harness-dom-acceptance.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
function report(){return{status:'passed',platform:'darwin',kind:'official-Harness-Mac-headless-DOM-subset',tests:DOM_HARNESS_CASES.map((name,index)=>({name,status:'passed',...(index===0?{details:{pages:Array.from({length:10},(_,id)=>({id}))}}:{})})),selection:{scope:'headless-dom-only',fullUIAcceptance:false,nativeUIAcceptance:false,excludedCases:DOM_HARNESS_EXCLUDED},headlessOnlyEvidence:{browserHeadless:true,domProtocolOnly:true,nativeCommandCalls:0,nativeDriverStarted:false,nativeFixtureCompiled:false,hostRetired:true,hostExitCode:0,hostSignal:null,browserCloseSucceeded:true},ownedCleanup:{passed:true},frontendErrors:[]}}
test('a genuine 8-case DOM subset with ten rendered setting pages can pass without native claims',()=>{assert.equal(assessDomHarnessReport(report()).passed,true)})
test('missing case, settings gap, native execution, failed Host retirement or full-native claim cannot pass',()=>{
 for(const mutate of [r=>r.tests.pop(),r=>r.tests[0].details.pages.pop(),r=>r.tests[1].status='failed',r=>r.headlessOnlyEvidence.nativeCommandCalls=1,r=>r.headlessOnlyEvidence.nativeDriverStarted=true,r=>r.headlessOnlyEvidence.nativeFixtureCompiled=true,r=>r.headlessOnlyEvidence.browserHeadless=false,r=>r.headlessOnlyEvidence.hostRetired=false,r=>r.headlessOnlyEvidence.hostExitCode=1,r=>r.headlessOnlyEvidence.browserCloseSucceeded=false,r=>r.headlessOnlyEvidence.hostSignal='SIGKILL',r=>r.selection.fullUIAcceptance=true,r=>r.selection.excludedCases=[],r=>r.frontendErrors.push('render failed')]){const r=report();mutate(r);assert.equal(assessDomHarnessReport(r).passed,false)}
 const r=report();r.tests.push({name:DOM_HARNESS_EXCLUDED[0],status:'passed'});assert.equal(assessDomHarnessReport(r).passed,false)
})
test('frozen source selects all DOM behaviors, forces headless, denies native calls and removes force-kill fallback',async()=>{
 const source=makeDomHarnessSource(await readFile(new URL('../scripts/e2e-harness.mjs',import.meta.url),'utf8'),{repository:'/original-repo/',providerSource:'/snapshot/tests/fixtures/harness-e2e-provider.mjs'})
 const cases=JSON.parse(/const featureEvidenceCases = new Set\((\[[^\n]+\])\)/u.exec(source)[1]);assert.deepEqual(cases,DOM_HARNESS_CASES);assert.ok(DOM_HARNESS_EXCLUDED.every(name=>!cases.includes(name)))
 assert.ok(source.includes('headless: true'));assert.ok(source.includes('entryPoints: ["/snapshot/tests/fixtures/harness-e2e-provider.mjs"]'))
 assert.ok(!source.includes("else if (host) await Promise.race"))
 const guard=/let forbiddenNativeCommandCalls = 0\nconst nativeCommand = [^\n]+/u.exec(source)[0]
 const invoke=new Function(guard+'; return async()=>{try{await nativeCommand()}catch(error){return{message:error.message,count:forbiddenNativeCommandCalls}}}')()
 assert.deepEqual(await invoke(),{message:'Native commands are excluded from this headless DOM scope',count:1})
 assert.throws(()=>makeDomHarnessSource('unrecognized runner',{repository:'/x',providerSource:'/y'}),/snapshot patch anchor/)
})
test('fresh immutable Mac candidate carrier prepares and plans without Host, browser or input',async t=>{
 try{await access('/Users/qiuya/QiuYaTools-验收/2026-10-22/安装包/Mac-键盘修复-66ae-验证包/dsh-qiuya-tools-darwin-universal.tgz')}catch{t.skip('Own exact Mac acceptance package is not on this test machine');return}
 const execute=promisify(execFile),made=JSON.parse((await execute(process.execPath,['scripts/prepare-harness-dom-acceptance.mjs'],{cwd:root,timeout:30000})).stdout)
 assert.equal(made.executed,false);assert.equal(made.candidateSHA256,'9b828d9bac4b08291bbdcef151096fcc2903b8fbbc87ae03a4f6ba26b3c5e6f3');assert.equal(made.snapshotImportSmoke.passed,true)
 const plan=JSON.parse((await execute(process.execPath,[made.entry,'--plan'],{cwd:root,timeout:30000})).stdout);assert.equal(plan.actualExecution,false);assert.equal(plan.guiStarted,false);assert.equal(plan.pdCommandsExecuted,0);assert.deepEqual(plan.selectedCases,DOM_HARNESS_CASES)
})
