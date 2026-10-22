import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,writeFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {assessBrowserDelivery,prepareBrowserVm} from '../scripts/windows-browser-evidence.mjs'
const execute=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url))
function row(browser){return{browser,status:'passed',passed:true,actualBrowser:true,checks:10,naturalNodeExit:true,nodeExitCode:0,reason:null,identity:{pid:42,createdAtTicks:'12345',executable:'C:\\private\\node.exe',sessionId:1}}}
function report(browsers=['chrome','edge']){return{passed:true,selectedBrowsers:browsers,checks:browsers.map(row),cleanup:{forcedNodeTermination:false,processSignalSent:false,remainingNodeProcesses:[]},error:null}}
test('selected Edge can independently pass all 10 checks without claiming Chrome execution',()=>{
 const result=assessBrowserDelivery(report(['edge']),'edge');assert.equal(result.passed,true);assert.deepEqual(result.selected,['edge']);assert.equal(result.individual.length,1)
 assert.equal(assessBrowserDelivery(report(),'all').passed,true)
})
test('missing Chrome remains not-run while independently completed Edge evidence is preserved',()=>{
 const data=report();data.passed=false;data.checks[0]={browser:'chrome',status:'not-run',passed:false,actualBrowser:false,checks:0,reason:'Required installed browser missing: chrome'}
 const result=assessBrowserDelivery(data,'all');assert.equal(result.passed,false);assert.equal(result.individual[0].status,'not-run');assert.equal(result.individual[1].passed,true)
 // A mistakenly green aggregate cannot promote missing dependency to business pass.
 data.passed=true;assert.equal(assessBrowserDelivery(data,'all').passed,false)
})
test('a passing browser cannot stand in for an omitted, duplicate or wrong immutable selection',()=>{
 const missing=report();missing.checks.pop();assert.equal(assessBrowserDelivery(missing,'all').passed,false)
 const duplicate=report();duplicate.checks[1]=row('chrome');assert.equal(assessBrowserDelivery(duplicate,'all').passed,false)
 assert.equal(assessBrowserDelivery(report(['edge']),'chrome').passed,false)
 assert.equal(assessBrowserDelivery(report(['edge']),'other').passed,false)
})
test('business counters never override process identity, exit, interruption or cleanup failures',()=>{
 for(const mutate of [r=>r.checks[0].checks=9,r=>r.checks[0].identity=null,r=>r.checks[0].naturalNodeExit=false,r=>r.checks[0].nodeExitCode=1,r=>r.cleanup.remainingNodeProcesses.push(99),r=>r.cleanup.forcedNodeTermination=true,r=>r.cleanup.processSignalSent=true,r=>r.error='audit failed']){
  const data=report(['edge']);mutate(data);assert.equal(assessBrowserDelivery(data,'edge').passed,false)
 }
})
test('reusable preparation resolves full snapshot import graph, plans with no PD and rejects tampered dependency',async()=>{
 const made=JSON.parse((await execute(process.execPath,['scripts/prepare-windows-browser-acceptance.mjs','--browser','edge'],{cwd:root,timeout:30000})).stdout)
 assert.equal(made.executed,false);assert.equal(made.snapshotImportSmoke.pdCommandsExecuted,0)
 for(const name of ['snapshot/guest.mjs','snapshot/smoke.mjs','snapshot/module.mjs'])assert.ok(made.snapshotImportSmoke.resolved.includes(name))
 const plan=JSON.parse((await execute(process.execPath,[made.entry,'--plan','--browser','edge'],{cwd:root,timeout:10000})).stdout)
 assert.equal(plan.executed,false);assert.deepEqual(plan.expectedChecks,{edge:10})
 await assert.rejects(execute(process.execPath,[made.entry,'--plan','--browser','chrome'],{cwd:root,timeout:10000}),/selection is immutable/)
 const dependency=join(dirname(made.entry),'windows-browser-evidence.mjs'),bytes=await readFile(dependency)
 try{await writeFile(dependency,Buffer.concat([bytes,Buffer.from('\n// mutation control\n')]))
  await assert.rejects(execute(process.execPath,[made.entry,'--plan'],{cwd:root,timeout:10000}),/Frozen carrier dependency changed/)
 }finally{await writeFile(dependency,bytes)}
})

test('paused assigned VM is normally resumed before guest work; running VM is not resumed',async()=>{
 for(const initialState of ['running','paused']){
  const calls=[],observed=[]
  const state=await prepareBrowserVm(async args=>{calls.push(args);return{stdout:'State: '+(calls.length===1?initialState:'running')+'\nPause idle: on\n'}},'owned-vm',value=>observed.push(value))
  assert.equal(state.initialState,initialState);assert.equal(state.runningConfirmed,true);assert.equal(state.originalPauseIdle,'on')
  assert.deepEqual(calls,initialState==='paused'?[['list','--info','owned-vm'],['set','owned-vm','--pause-idle','off'],['resume','owned-vm'],['list','--info','owned-vm']]:[['list','--info','owned-vm'],['set','owned-vm','--pause-idle','off'],['list','--info','owned-vm']])
  assert.equal(observed[0].originalPauseIdle,'on')
 }
})
test('stopped VM is rejected without mutation, and failed resume retains original idle receipt',async()=>{
 const calls=[];await assert.rejects(prepareBrowserVm(async args=>{calls.push(args);return{stdout:'State: stopped\nPause idle: on\n'}},'owned-vm'),/running or paused/);assert.equal(calls.length,1)
 const observed=[];await assert.rejects(prepareBrowserVm(async args=>{if(args[0]==='resume')throw Error('resume denied');return{stdout:'State: paused\nPause idle: off\n'}},'owned-vm',value=>observed.push(value)),/resume denied/)
 assert.equal(observed[0].originalPauseIdle,'off');assert.equal(observed.at(-1).resumeRequested,true);assert.equal(observed.at(-1).resumed,false)
})
