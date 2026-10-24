import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { makeKeyboardDeadlinePolicyFixture } from '../scripts/macos-keyboard-deadline-policy-fixture.mjs'
import { projectVisionRuntimeFailure } from '../scripts/live-vision-guard-core.mjs'

export function naturalPureCommand(command,args,budget=30000) {
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']}),out=[],err=[];let bytes=0,errorBytes=0,timer
  const result=new Promise((resolve,reject)=>{
    child.once('error',reject)
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes<=1024*1024)out.push(b)})
    child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes<=65536)err.push(b)})
    child.once('exit',(code,signal)=>resolve({code,signal,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString(),bytes,errorBytes}))
  })
  return Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>{child.unref();child.stdout.unref();child.stderr.unref();reject(Object.assign(Error('Pure compiler/process deadline; retained without signal or replay'),{code:'PURE_PROCESS_UNKNOWN',pid:child.pid}))},budget)})]).finally(()=>clearTimeout(timer))
}

test('actual extracted Swift policy recovers only expired cannotComplete with a fresh proof; all original caps and invalidation fences stay closed', {skip:process.platform!=='darwin',timeout:65000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'qiuya-keyboard-policy-pure-')),source=join(directory,'Policy.swift'),executable=join(directory,'policy')
  const actual=await readFile(new URL('../src/native/macos/FocusPreparation.swift',import.meta.url),'utf8'),fixture=makeKeyboardDeadlinePolicyFixture(actual)
  assert(!/import AppKit|import ApplicationServices|CGEvent\(|AXUIElement/u.test(fixture))
  await writeFile(source,fixture)
  const compile=await naturalPureCommand('/usr/bin/swiftc',['-swift-version','5','-parse-as-library','-module-cache-path',join(directory,'module-cache'),source,'-o',executable])
  await writeFile(join(directory,'compile-result.json'),JSON.stringify(compile,null,2))
  assert.equal(compile.code,0,compile.stderr);assert.equal(compile.signal,null)
  const run=await naturalPureCommand(executable,[],10000);await writeFile(join(directory,'run-result.json'),JSON.stringify(run,null,2))
  assert.equal(run.code,0,run.stdout+run.stderr);assert.equal(run.signal,null)
  const report=JSON.parse(run.stdout);assert.equal(report.passed,true);assert(report.caseCount>=27)
  for(const key of ['actualAXReads','actualWindows','actualInputEvents'])assert.equal(report[key],0)
  assert.equal(report.fullProofLimitMs,60);assert.equal(report.sharedActionRetryBudgetMs,500);assert.equal(report.maximumYieldMs,10)
  t.diagnostic('Compiled actual pure policy and diagnostics only; no AppKit/AX/UI/input. Evidence '+directory)
})

test('single-sample/retry diagnostics retain finite metadata only and never grant action authority',()=>{
  const value=projectVisionRuntimeFailure({code:'FOCUS_CHANGED'},{available:true,focusAttempt:{keyboardSampleMs:61,keyboardTransientAXRetries:1,keyboardReadinessRetries:1,keyboardRetryBudgetRemainingMs:427,keyboardSampleDeadlineExceeded:true,keyboardSampleReadyExpired:false,keyboardIndependentIdentityAccepted:true,keyboardReadyProofExpired:false,text:'PRIVATE_TEXT',processName:'PRIVATE_PROCESS'}})
  assert.equal(value.focus.keyboardSampleMs,61);assert.equal(value.focus.keyboardReadinessRetries,1);assert.equal(value.focus.keyboardRetryBudgetRemainingMs,427);assert.equal(value.focus.keyboardIndependentIdentityAccepted,true);assert.equal(value.focus.keyboardReadyProofExpired,false)
  assert.equal(value.focus.keyboardSampleReadyExpired,false)
  assert(!JSON.stringify(value).includes('PRIVATE_'))
  const unknown=projectVisionRuntimeFailure({code:'FOCUS_CHANGED'},{available:true,focusAttempt:{keyboardSampleMs:Infinity,keyboardReadinessRetries:'PRIVATE',keyboardIndependentIdentityAccepted:'PRIVATE',keyboardReadyProofExpired:1}})
  for(const key of ['keyboardSampleMs','keyboardReadinessRetries','keyboardIndependentIdentityAccepted','keyboardReadyProofExpired'])assert.equal(unknown.focus[key],null)
})
