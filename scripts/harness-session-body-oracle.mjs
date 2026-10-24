/** Test-only independent own-window AX oracle, invoked only by the separately gated full UI runner. */
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const sha=b=>createHash('sha256').update(b).digest('hex'),finite=new Set(['accessibility-not-granted','ax-read-budget','own-ax-body-incomplete','own-ax-windows-unavailable','ax-window-not-uniquely-confirmed'])
export function validateIndependentSessionBody(value,{target,title,observation}){
 if(!value||value.available!==true||value.complete!==true||value.targetId!==target.id||value.frameId!==observation.frameId||value.imageSHA256!==sha(Buffer.from(observation.imageBase64,'base64'))||typeof value.text!=='string'||value.text.length>30000||sha(Buffer.from(value.text))!==value.textSHA256||value.inputEventsPosted!==0||value.captureCalls!==0||value.signalsSent!==0)return false
 const pin=value.binding,g=observation.geometry
 return pin?.target?.pid===target.pid&&pin?.windowID===Number(target.id.replace('mac-window:',''))&&pin?.title===target.title&&pin?.title.includes(title)&&['x','y','width','height'].every(k=>pin.frame?.[k]===g?.[k])&&value.text.includes(title)&&value.text.includes('已完成本地测试回复：'+title)&&!/(?:正在加载|加载中|Loading[.…])/u.test(value.text)
}
export function createOwnSessionBodyOracle({root,temporary,profileRoot,host,runnerPID,run}){
 assert(typeof run==='function');let compiled;const bindings=new Map()
 const executable=join(temporary,'harness-session-body-readonly')
 const remaining=deadline=>{const value=Math.floor(deadline-Date.now());assert(value>0,'Independent oracle original shared deadline expired');return Math.max(1,Math.min(30000,value))}
 const command=async(input,deadline)=>{const value=JSON.parse(await run(executable,['--request-json',JSON.stringify(input)],remaining(deadline)));assert(Date.now()<=deadline,'Independent oracle command exceeded original shared deadline');assert(value&&typeof value.ok==='boolean');return value}
 return async({target,title,observation,deadline})=>{
  assert(/^E2E:(Alpha|Beta)-[A-Za-z\d]+$/u.test(title)&&target.appId==='com.qiuya.tools.session-window'&&target.title===title+' — QiuYaTools'&&/^mac-window:\d+$/u.test(target.id));assert(host?.pid&&host.exitCode===null&&Number.isInteger(runnerPID)&&runnerPID>1&&Date.now()<deadline)
  const frame={x:observation.geometry.x,y:observation.geometry.y,width:observation.geometry.width,height:observation.geometry.height},base={targetId:target.id,frameId:observation.frameId,imageSHA256:sha(Buffer.from(observation.imageBase64,'base64')),inputEventsPosted:0,captureCalls:0,signalsSent:0}
  compiled??=run('/usr/bin/swiftc',['-parse-as-library','-module-cache-path',join(temporary,'readonly-oracle-module-cache'),'-framework','ApplicationServices','-framework','CoreGraphics','-framework','CryptoKit',join(root,'tests/fixtures/harness-session-body-readonly.swift'),'-o',executable],remaining(deadline));await compiled
  assert(Date.now()<deadline,'Independent oracle compile exceeded original shared deadline')
  const key=target.pid+':'+target.id;let pin=bindings.get(key)
  if(!pin){const result=await command({op:'bind',profileRoot:await realpath(profileRoot),hostPID:host.pid,runnerPID,targetPID:target.pid,windowID:Number(target.id.replace('mac-window:','')),title:target.title,frame},deadline);assert(result.ok===true,'Exact own session read-only binding was not confirmed: '+String(result.code??'unknown'));pin=result.value.binding;bindings.set(key,pin)}
  // A resize may update geometry while the exact immutable process/window identities remain pinned.
  pin={...pin,frame};const result=await command({op:'observe',binding:pin,budgetMs:Math.max(1,Math.min(1500,Math.floor(deadline-Date.now())))},deadline)
  if(result.ok!==true){if(finite.has(result.code))return{...base,available:false,code:result.code};throw Error('Independent own session identity/oracle failed: '+String(result.code??'unknown'))}
  assert(Date.now()<=deadline,'Independent AX read exceeded original shared deadline')
  return {...result.value,...base,available:true}
 }
}
