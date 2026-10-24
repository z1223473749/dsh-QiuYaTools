/** Test-only final-frame/own-file readback. No process launch, model calls or input. */
import assert from 'node:assert/strict'
import {constants} from 'node:fs'
import {open,lstat,realpath} from 'node:fs/promises'
import {join,resolve,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {validateIndependentSessionBody} from './harness-session-body-oracle.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
export function finalNativeSessionBody(observation,{target,title,sessionId},independent){
 assert.ok(/^E2E:(Alpha|Beta)-[A-Za-z\d]+$/u.test(title)&&/^[A-Za-z\d_.:-]{1,512}$/u.test(sessionId))
 const elements=String(observation?.elements??''),reply='已完成本地测试回复：'+title,g=observation?.geometry
 return !!observation&&observation.targetId===target.id&&Number.isFinite(observation.width)&&observation.width>100&&Number.isFinite(observation.height)&&observation.height>100&&typeof observation.imageBase64==='string'&&observation.imageBase64.length>100&&g&&['x','y','width','height'].every(k=>Number.isFinite(g[k]))&&(independent===undefined?elements.includes(title)&&elements.includes(reply):validateIndependentSessionBody(independent,{target,title,observation}))&&!/(?:正在加载|加载中|Loading[.…])/u.test(elements)
}
export async function waitFinalNativeSession({driver,target,title,sessionId,deadline,acknowledged,record,readBody,recordFailureRaster,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms))}){
 assert.ok(Number.isFinite(deadline)&&deadline>now()&&typeof acknowledged==='function');let previous,stable=0,stage='await-ack',observation,result,failure,lastIndependent;const independentBodies=new Map(),samples=[],stageSamples=[],bodies=new Map(),startedAt=now()
 const add=row=>{const entry={at:now(),elapsedMs:now()-startedAt,stage,...row};if(stageSamples.length<96)stageSamples.push(entry);else stageSamples[95]=entry;if(stage==='body-check'){if(samples.length<96)samples.push(entry);else samples[95]=entry}}
 const finiteFailure=e=>({name:['TimeoutError','AbortError','AssertionError','Error'].includes(e?.name)?e.name:'other',code:['ABORT_ERR','ERR_ASSERTION','CAPTURE_BUSY','CAPTURE_TIMEOUT','NATIVE_TIMEOUT','NATIVE_DISCONNECTED','NATIVE_PIPE_FAILED','TARGET_CHANGED','TARGET_GONE'].includes(e?.code)?e.code:'other'})
 const remaining=()=>Math.max(1,Math.floor(deadline-now()))
 try{
  while(now()<deadline){
   stage='await-ack';if(!acknowledged()){add({acknowledged:false});await sleep(Math.min(100,Math.max(1,deadline-now())));continue}
   stage='target-read';add({phase:'started',remainingMs:remaining()});const targets=await driver.targets(AbortSignal.timeout(remaining())),exact=targets.filter(row=>row.id===target.id&&row.pid===target.pid&&row.appId===target.appId&&row.title.includes(title));assert.equal(exact.length,1,'Own native PID/window/app/session-title changed before final capture')
   stage='observe-read';const observeStarted=now();add({phase:'started',remainingMs:remaining()});observation=await driver.observe(target.id,AbortSignal.timeout(remaining()))
   stage='independent-body-read';if(readBody){lastIndependent=await readBody({target,title,observation,deadline});if(lastIndependent?.available===true&&!independentBodies.has(lastIndependent.textSHA256)){independentBodies.set(lastIndependent.textSHA256,{...lastIndependent,text:lastIndependent.text.slice(0,4096),excerptOnly:lastIndependent.text.length>4096});if(independentBodies.size>4)independentBodies.delete(independentBodies.keys().next().value)}}
   stage='body-check';const ready=finalNativeSessionBody(observation,{target,title,sessionId},readBody?(lastIndependent??{available:false,code:"oracle-unavailable"}):undefined),geometry=JSON.stringify(observation.geometry),elements=String(observation.elements??''),bodySHA256=hash(elements),row={ready,width:observation.width,height:observation.height,geometry:observation.geometry,targetId:observation.targetId,bodySHA256,bodyCharacters:elements.length,containsTitle:elements.includes(title),containsExpectedReply:elements.includes('已完成本地测试回复：'+title),containsLoading:/(?:正在加载|加载中|Loading[.…])/u.test(elements),observeElapsedMs:now()-observeStarted,...readBody?{independentAvailable:lastIndependent?.available===true,independentCode:lastIndependent?.code??null,independentBodySHA256:lastIndependent?.textSHA256??null}: {}}
   if(!bodies.has(bodySHA256)){bodies.set(bodySHA256,{bodySHA256,characters:elements.length,excerpt:elements.slice(0,4096)});if(bodies.size>4)bodies.delete(bodies.keys().next().value)}
   add(row);stable=ready&&previous===geometry?stable+1:ready?1:0;previous=ready?geometry:undefined
   if(stable>=2){stage='post-target-read';add({phase:'started',remainingMs:remaining()});const after=(await driver.targets(AbortSignal.timeout(remaining()))).filter(row=>row.id===target.id&&row.pid===target.pid&&row.appId===target.appId&&row.title.includes(title));assert.equal(after.length,1,'Own native window changed after final capture');assert.ok(acknowledged(),'Public exact-session native window acknowledgment was lost');assert.ok(now()<=deadline,'Final capture exceeded original shared 35000ms window budget');stage='complete';result=observation;return observation}
   if(now()<deadline)await sleep(Math.min(100,deadline-now()))
  }
  throw Error('Exact own native Session body did not become loaded and stable within its original shared 35000ms budget; no input replay or loading screenshot accepted')
 }catch(error){failure=finiteFailure(error);throw error}
 finally{
  const evidence={sessionId,title,target:{id:target.id,pid:target.pid,appId:target.appId},sameExactTarget:result!==undefined,exactPublicSessionAcknowledged:acknowledged()===true,expectedReply:'已完成本地测试回复：'+title,bodyLoaded:result!==undefined,notLoading:result!==undefined,consecutiveStableFrames:stable,capturedImageSHA256:result?hash(Buffer.from(result.imageBase64,'base64')):null,capturedImageBytes:result?Buffer.from(result.imageBase64,'base64').length:0,deadline,startedAt,endedAt:now(),lastStage:stage,status:result?'passed':'failed',failure:failure??null,samples,stageSamples,distinctOwnAXBodies:[...bodies.values()],independentOracleRequired:typeof readBody==='function',independentOwnAXBodies:[...independentBodies.values()],inputReplayed:false,originalSharedBudgetMs:35000,deadlineResets:0,source:readBody?'Actual packaged exact-window raster plus independent complete own AX body; full nonce/no-loading/two-frame/original35s predicates retained; no input replay':'Actual packaged native observe AX body and exact raster; failed-attempt diagnostics retained without changing readiness, identity or deadline predicates'}
  if(failure&&observation&&recordFailureRaster){try{evidence.diagnosticFailureRaster=await recordFailureRaster(observation)}catch{evidence.diagnosticFailureRaster={status:'unavailable'}}}
  try{await record(evidence)}catch(error){if(!failure)throw error}
 }
}

export async function readFinalOwnUploadedFile({directory,name,expectedBytes,expectedSHA256}){
 assert.equal(resolve(directory),directory);assert.equal(basename(name),name);assert.ok(name.startsWith('E2E-共享-你好-')&&Number.isSafeInteger(expectedBytes)&&expectedBytes===8*1024*1024&&/^[a-f\d]{64}$/u.test(expectedSHA256));assert.equal(await realpath(directory),directory)
 const path=join(directory,name),before=await lstat(path);assert.ok(before.isFile()&&!before.isSymbolicLink()&&before.size===expectedBytes);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const opened=await file.stat();assert.equal(opened.dev,before.dev);assert.equal(opened.ino,before.ino);const bytes=await file.readFile();assert.equal(bytes.length,expectedBytes);assert.equal(hash(bytes),expectedSHA256);const after=await file.stat(),leaf=await lstat(path);for(const s of[after,leaf])for(const k of['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(s[k],opened[k]);assert.ok(!leaf.isSymbolicLink());return{openedHandle:true,bytes:bytes.length,sha256:expectedSHA256,dev:String(opened.dev),ino:String(opened.ino),stableIdentity:true,readOnly:true,noFollow:true}}
 finally{await file.close()}
}
