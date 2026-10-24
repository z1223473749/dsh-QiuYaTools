import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,readFile,rm,link,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {sourceProjectionValid,preserveOwnedMacInputSource,passiveObserverChannel,ownedMacInputSourceFailure,HARNESS_PASSIVE_OBSERVER_SHA256,OwnedMacInputSourceTrace} from './fixtures/harness-passive-input-source.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')
const scope=profile=>({hostPid:process.pid,profileSHA256:sha(profile),targetId:'mac-window:1',observerSHA256:HARNESS_PASSIVE_OBSERVER_SHA256,OwnedMacInputSourceTrace})
const row=(profile,value)=>({utc:new Date().toISOString(),monotonicNs:'1',scope:scope(profile),...value})
const stop=profile=>row(profile,{phase:'stop',trace:{mode:'listenOnly',postsInput:false,maximumEvents:128,maximumWindowMs:500,events:[{type:'mouseMoved',sourcePID:0,sourceRelation:'other',deltaX:0,deltaY:0}],workerRetired:true,tapInvalidated:true,failure:null}})
test('source0 mouse metadata is retained as other, not exempted',()=>assert.equal(sourceProjectionValid(stop('/own')),true))
for(const field of ['keyCode','Unicode','characters'])test('keyboard content field '+field+' cannot enter an event record',()=>{const value=stop('/own');value.trace.events=[{type:'keyDown',sourcePID:1,[field]:'forbidden'}];assert.equal(sourceProjectionValid(value),false)})
test('keyboard metadata never retains pointer coordinates or deltas',()=>{const value=stop('/own');value.trace.events=[{type:'flagsChanged',sourcePID:0,deltaX:0}];assert.equal(sourceProjectionValid(value),false)})
test('event count and fixed500ms scope cannot grow',()=>{const a=stop('/own');a.trace.events=Array.from({length:129},()=>({type:'mouseMoved'}));assert.equal(sourceProjectionValid(a),false);const b=stop('/own');b.trace.maximumWindowMs=501;assert.equal(sourceProjectionValid(b),false)})
test('preparation failure projection has finite stages and codes, not free-form messages',()=>{assert(sourceProjectionValid(row('/own',{phase:'unavailable',stage:'own-children',code:'SOURCE_OBSERVER_REJECTED',remoteCode:'own-child-identity-unavailable'})));assert(!sourceProjectionValid(row('/own',{phase:'unavailable',stage:'arbitrary personal data',code:'SOURCE_DIAGNOSTIC_FAILED'})));assert(!sourceProjectionValid(row('/own',{phase:'unavailable',stage:'ready',code:'free-form error message'})))})
async function fixture(work,{partial=false}={}){
 const base=await mkdtemp(join(tmpdir(),'qiuya-harness-e2e-')),profileRoot=join(base,'qiuya-harness-home'),output=join(base,'output');await mkdir(profileRoot);await mkdir(output)
 const profile=await realpath(profileRoot)
 await writeFile(join(profile,'e2e-computer-target.json'),JSON.stringify({targetId:'mac-window:1',sessionId:'own-test-only'}))
 const rows=partial?[row(profile,{phase:'prepare',stage:'host-identity'}),row(profile,{phase:'unavailable',stage:'host-identity',code:'SOURCE_OBSERVER_REQUEST_TIMEOUT'}),row(profile,{phase:'exit',result:{code:0,signal:null}})]:[row(profile,{phase:'start',pins:{host:{pid:process.pid},windowId:1}}),stop(profile),row(profile,{phase:'exit',result:{code:0,signal:null}})]
 await writeFile(join(profile,'owned-mac-input-source.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n')
 try{await work({profileRoot:profile,output:await realpath(output),host:{pid:process.pid,retired:true,exitCode:0,signal:null,forced:false}})}finally{await rm(base,{recursive:true,force:true})}
}
test('complete own trace is copied only after true natural Host exit',()=>fixture(async value=>{assert.equal((await preserveOwnedMacInputSource({...value,host:{...value.host,retired:false}})).status,'unavailable');const result=await preserveOwnedMacInputSource(value);assert.equal(result.status,'preserved');assert.equal(result.complete,true);assert.equal(result.nativeInputCalls,0);assert.equal(result.permitsHumanAttribution,false);assert.match(await readFile(join(value.output,result.relativeFile),'utf8'),/sourcePID/)}))
test('preparation failure is preserved without pretending a tap or input occurred',()=>fixture(async value=>{assert.deepEqual(ownedMacInputSourceFailure(value.profileRoot,process.pid),{code:'SOURCE_OBSERVER_REQUEST_TIMEOUT',stage:'host-identity'});const result=await preserveOwnedMacInputSource(value);assert.equal(result.status,'preserved');assert.equal(result.complete,false);assert.deepEqual(result.diagnosticFailure,{code:'SOURCE_OBSERVER_REQUEST_TIMEOUT',stage:'host-identity'});assert.equal(result.permitsHumanAttribution,false);assert(!/"events"|"phase":"start"/.test(await readFile(join(value.output,result.relativeFile),'utf8')))}, {partial:true}))
test('different exact target is rejected even when Host matches',()=>fixture(async value=>{await writeFile(join(value.profileRoot,'e2e-computer-target.json'),JSON.stringify({targetId:'mac-window:2'}));assert.equal((await preserveOwnedMacInputSource(value)).status,'unavailable')}))
test('different Host PID cannot preserve the same profile trace',()=>fixture(async value=>{assert.equal((await preserveOwnedMacInputSource({...value,host:{...value.host,pid:process.pid+1}})).status,'unavailable')}))
test('hardlinked trace is rejected',()=>fixture(async value=>{await link(join(value.profileRoot,'owned-mac-input-source.jsonl'),join(value.profileRoot,'second-link'));assert.equal((await preserveOwnedMacInputSource(value)).status,'unavailable')}))
async function channel(script,work,{timeoutMs=300}={}){
 // This is a normal own Node process: no native framework, window, tap or input.
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']})
 const value=passiveObserverChannel(child,{timeoutMs})
 try{await work(value,child)}finally{const retired=await value.close();assert.equal(retired.signal,null);assert.equal(retired.code,0)}
}
const ready="console.log(JSON.stringify({event:'ready',postsInput:false,activatesWindows:false}));"
const lines="import readline from 'node:readline';const input=readline.createInterface({input:process.stdin});for await(const line of input){const command=JSON.parse(line);"
test('real subprocess ready+request remains correlated and retires on stdin EOF',()=>channel(ready+lines+"console.log(JSON.stringify({requestId:command.requestId,ok:true,result:{operation:command.op}}));}",async value=>{assert.equal((await value.ready()).postsInput,false);assert.deepEqual(await value.request('identity'),{operation:'identity'});assert.deepEqual(await value.request('allChildren'),{operation:'allChildren'})}))
test('real subprocess remote error maps only a fixed code and caller can close',()=>channel(ready+lines+"console.log(JSON.stringify({requestId:command.requestId,ok:false,error:'own-child-identity-unavailable'}));}",async value=>{await value.ready();await assert.rejects(value.request('allChildren'),error=>error.code==='SOURCE_OBSERVER_REJECTED'&&error.remoteCode==='own-child-identity-unavailable')}))
test('real subprocess free-form errors are never retained',()=>channel(ready+lines+"console.log(JSON.stringify({requestId:command.requestId,ok:false,error:'SECRET PERSONAL CONTENT'}));}",async value=>{await value.ready();await assert.rejects(value.request('identity'),error=>error.code==='SOURCE_OBSERVER_REJECTED'&&error.remoteCode===undefined&&!error.message.includes('SECRET'))}))
test('real subprocess silently missing ready fails finitely and exits by EOF',()=>channel("process.stdin.resume();",async value=>{await assert.rejects(value.ready(),error=>error.code==='SOURCE_OBSERVER_READY_TIMEOUT')},{timeoutMs:80}))
test('real subprocess missing reply fails finitely and forbids another request',()=>channel(ready+lines+"}",async value=>{await value.ready();await assert.rejects(value.request('identity'),error=>error.code==='SOURCE_OBSERVER_REQUEST_TIMEOUT');await assert.rejects(value.request('identity'),error=>error.code==='SOURCE_OBSERVER_REQUEST_TIMEOUT')},{timeoutMs:80}))
test('real subprocess malformed JSON fails finitely without retaining raw content',()=>channel("console.log('SECRET INVALID JSON');process.stdin.resume();",async value=>{await assert.rejects(value.ready(),error=>error.code==='SOURCE_OBSERVER_INVALID_JSON'&&!error.message.includes('SECRET'))}))
test('real subprocess early EOF rejects pending reply, not an unbounded wait',()=>channel(ready+lines+"break;}process.stdin.destroy();",async value=>{await value.ready();await assert.rejects(value.request('identity'),error=>error.code==='SOURCE_OBSERVER_EARLY_EXIT')}))

async function providerFailure(method){
 const base=await mkdtemp(join(tmpdir(),'qiuya-harness-e2e-')),profile=join(base,'qiuya-harness-home');await mkdir(profile)
 const oldEnv=Object.fromEntries(['DSH_HOME','QIUYA_HARNESS_E2E','QIUYA_PASSIVE_INPUT_SOURCE','QIUYA_OWNED_PREVIEW_TRACE'].map(key=>[key,process.env[key]]))
 const originals=Object.fromEntries(['prepare','start'].map(key=>[key,OwnedMacInputSourceTrace.prototype[key]])),calls=[]
 const disposers=[];let adapter
 try{
  process.env.DSH_HOME=profile;process.env.QIUYA_HARNESS_E2E='1';process.env.QIUYA_PASSIVE_INPUT_SOURCE='1';delete process.env.QIUYA_OWNED_PREVIEW_TRACE
  for(const name of ['prepare','start'])OwnedMacInputSourceTrace.prototype[name]=async function(){calls.push(name);return name!==method}
  const {apply}=await import('./fixtures/harness-e2e-provider.mjs')
  apply({effect(callback){const value=callback();if(typeof value==='function')disposers.push(value)},connection:{fetch:{register(){return ()=>{}}}},llm:{registerAdapter(_providers,value){adapter=value;return ()=>{}}}})
  await writeFile(join(profile,'e2e-computer-target.json'),JSON.stringify({targetId:'mac-window:1',query:'OWNFIXTURE'}))
  const tools=['discover','request_control','targets','select','observe','act'].map(n=>({name:'qiuya_computer_'+n}))
  const messages=[{role:'user',content:[{type:'text',text:'E2E:computer-move'}]}],outputs=[]
  async function next(result){if(result!==undefined)messages.push({role:'tool',content:[{type:'text',text:JSON.stringify(result)}]});const output=[];for await(const value of adapter.stream({sessionId:'own-test',tools,messages,maxTokens:4096}))output.push(value);outputs.push(output);return output}
  await next();await next({applications:[{appName:'OWNFIXTURE',candidateId:'candidate'}]});await next({granted:true});await next({targets:[{id:'mac-window:1'}]})
  const prepared=await next({selected:true})
  if(method==='start'){
   assert(prepared.some(value=>value.name==='qiuya_computer_observe'))
   messages.push({role:'tool',content:[{type:'image',attachment:{attachmentId:'own-fake-image',width:100,height:100,mediaType:'image/jpeg'}}]})
   await next({frameId:'own-frame'})
  }
  const terminal=outputs.at(-1);assert(terminal.some(value=>value.type==='text-delta'&&value.text==='E2E_PASSIVE_SOURCE_DIAGNOSTIC_UNAVAILABLE'));assert(terminal.some(value=>value.type==='finish'&&value.reason.kind==='stop'));assert(!terminal.some(value=>value.type==='tool-call-delta'));assert(!outputs.flat().some(value=>value.name==='qiuya_computer_act'))
  if(method==='prepare')assert(!outputs.flat().some(value=>value.name==='qiuya_computer_observe'))
  assert.deepEqual(calls,method==='prepare'?['prepare']:['prepare','start'])
 }finally{for(const dispose of disposers.reverse())await dispose();for(const [key,value]of Object.entries(originals))OwnedMacInputSourceTrace.prototype[key]=value;for(const [key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(base,{recursive:true,force:true})}
}
test('actual provider generator terminates a prepare failure before original observe/act; no SDK exception/retry',()=>providerFailure('prepare'))
test('actual provider generator terminates a start failure after image receipt but before original act',()=>providerFailure('start'))
test('mutable trace incomplete tail cannot become an invented failure',()=>fixture(async value=>{const path=join(value.profileRoot,'owned-mac-input-source.jsonl'),first=row(value.profileRoot,{phase:'prepare',stage:'ready'});await writeFile(path,JSON.stringify(first)+'\n'+JSON.stringify({phase:'unavailable'}).slice(0,9));assert.equal(ownedMacInputSourceFailure(value.profileRoot,process.pid),null)}))
