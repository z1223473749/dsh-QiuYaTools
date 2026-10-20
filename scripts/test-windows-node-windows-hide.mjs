/** Real Node/libuv windowsHide startup regression; run only in an interactive Windows test desktop. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join,resolve } from 'node:path'
if(process.platform!=='win32')throw new Error('This regression requires actual Windows')
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]},helper=resolve(arg('--helper')),output=resolve(arg('--output')),children=[],checks=[]
await mkdir(output,{recursive:true});const stateFile=join(output,'fixture-state.json'),delay=ms=>new Promise(d=>setTimeout(d,ms))
function companion(args,windowsHide=true){
 const child=spawn(helper,args,{windowsHide,stdio:['pipe','pipe','pipe'],env:{...process.env,QIUYA_TOOLS_PARENT_PID:String(process.pid),QIUYA_TOOLS_NATIVE_DATA_DIR:join(output,'browser-data')}});children.push(child);child.stderr.resume()
 const pending=new Map();let next=0;const lines=createInterface({input:child.stdout})
 lines.on('line',line=>{try{const answer=JSON.parse(line),entry=pending.get(answer.requestId);if(entry){clearTimeout(entry.timer);pending.delete(answer.requestId);answer.ok?entry.done(answer.result):entry.reject(new Error(answer.error?.code||'native-failed'))}}catch{}})
 child.once('exit',()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Native worker exited'))};pending.clear();lines.close()})
 return {child,rpc:(op,body={})=>new Promise((done,reject)=>{const requestId=++next,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`${op} timeout`))},40000);pending.set(requestId,{done,reject,timer});child.stdin.write(JSON.stringify({requestId,op,...body})+'\n')})}
}
async function until(operation,message){for(let i=0;i<100;i++){const result=await operation();if(result)return result;await delay(100)}throw new Error(message)}
let report
try{
 const fixture=companion(['--fixture','--fixture-output',stateFile],false)
 const state=await until(()=>readFile(stateFile,'utf8').then(JSON.parse,()=>undefined),'Fixture startup timed out')
 const computer=companion(['--computer']),session=companion([]),observer=companion(['--computer'])
 await computer.rpc('status');await observer.rpc('status')
 const identity='node-hidden-session',payload={sessionId:identity,storeIdentifier:randomUUID(),url:`http://127.0.0.1:${state.port}/?qiuya-session=${identity}`,title:'Node hidden session',source:'drag'}
 await session.rpc('prepare',payload);assert.ok(!(await computer.rpc('targets')).some(target=>target.pid===session.child.pid));checks.push({id:'NODE-HIDE-PREPARE-STAYS-HIDDEN',passed:true})
 await session.rpc('open',{...payload,source:'menu'});const target=await until(async()=>(await computer.rpc('targets')).find(target=>target.pid===session.child.pid&&target.title.includes(identity)),'Node-hidden session completed ready but did not become visible')
 checks.push({id:'NODE-HIDE-SESSION-VISIBLE',passed:true,target:{id:target.id,title:target.title,pid:target.pid}})
 await session.rpc('open',{...payload,source:'menu'});assert.equal((await computer.rpc('targets')).filter(target=>target.pid===session.child.pid).length,1);checks.push({id:'NODE-HIDE-SESSION-REUSE',passed:true})
 await computer.rpc('openPreview',{sessionId:'node-preview',url:`http://127.0.0.1:${state.port}/preview`,title:'QiuYaTools Node Hidden Preview'})
 const preview=await until(async()=>(await observer.rpc('targets')).find(target=>target.pid===computer.child.pid&&target.title.startsWith('QiuYaTools Node Hidden Preview')),'Node-hidden preview did not become visible')
 const image=await observer.rpc('observe',{targetId:preview.id,preview:true});assert.ok(Number.isFinite(image.cursor?.x)&&Number.isFinite(image.cursor?.y)&&typeof image.cursor.visible==='boolean');await writeFile(join(output,'node-hidden-preview.jpg'),Buffer.from(image.imageBase64,'base64'));checks.push({id:'NODE-HIDE-PREVIEW-VISIBLE-CAPTURE',passed:true,target:{id:preview.id,title:preview.title,pid:preview.pid},width:image.width,height:image.height})
 await computer.rpc('closePreview');assert.ok(!(await observer.rpc('targets')).some(target=>target.pid===computer.child.pid));checks.push({id:'NODE-HIDE-PREVIEW-CLOSES',passed:true})
 report={passed:true,checks,platform:process.platform,architecture:process.arch,actualNodeSpawn:true,nodeVersion:process.version,windowsHide:true,fixturePid:fixture.child.pid}
}catch(error){report={passed:false,checks,error:error.message,stack:error.stack,platform:process.platform,architecture:process.arch,actualNodeSpawn:true,windowsHide:true}}
finally{for(const child of children){child.stdin.end();await Promise.race([new Promise(done=>child.once('exit',done)),delay(1800)]);if(child.exitCode===null)child.kill()};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:checks.length,output,error:report.error}));if(!report.passed)process.exitCode=1}
